import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
  ParseEnumPipe,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupResolverService } from './services/group-resolver.service';
import { NotificationSenderService } from './services/notification-sender.service';
import { CompletionService } from '@agent/completion.service';
import { GroupTaskType, GroupContext } from './group-task.types';
import {
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
  PlanJobData,
  PrepareJobData,
  SendJobData,
  SummarizeJobData,
} from './queue/group-task-queue.constants';

type AnyGroupTaskJob = Job<PlanJobData | PrepareJobData | SendJobData | SummarizeJobData>;

/**
 * 群任务 Controller
 *
 * 面向 dashboard / 运维的入口：
 *   POST /group-task/trigger/:type  → 将任务入 Bull plan 队列（不阻塞）
 *   POST /group-task/retry/:type    → 把该类型下失败的 send job 重新排队（补发差集）
 *   GET  /group-task/status/:type   → 查看该类型当前队列状态（排障）
 *   POST /group-task/test-send      → 单群测试（飞书预览 / 真实发送）
 *
 * 显式声明 ApiTokenGuard，防止全局 Guard 配置变更时意外暴露。
 */
@UseGuards(ApiTokenGuard)
@Controller('group-task')
export class GroupTaskController {
  constructor(
    private readonly scheduler: GroupTaskSchedulerService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly completionService: CompletionService,
    @InjectQueue(GROUP_TASK_QUEUE_NAME) private readonly groupTaskQueue: Queue,
  ) {}

  /**
   * 手动触发指定类型的通知任务（入队后立即返回 execId）。
   *
   * forceEnabled=true 绕过 enabled 开关（即使定时任务关闭也能执行），
   * 但仍遵守 DB 中的 dryRun 设置（试运行时只发飞书不发企微）。
   */
  @Post('trigger/:type')
  async trigger(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    const strategy = this.scheduler.getStrategy(type);
    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const { execId, skipped } = await this.scheduler.executeTask(strategy, {
      forceEnabled: true,
      trigger: 'manual',
    });

    if (skipped === 'disabled') {
      return {
        success: false,
        skipped: 'disabled',
        message: '群任务已在 system_config 中禁用',
      };
    }

    return {
      success: true,
      execId,
      skipped: skipped ?? null,
      message: '已排入 plan 队列，发送将异步进行',
      type,
    };
  }

  /**
   * 补发：把该类型下 failed 的 send job 整体 retry 一遍。
   *
   * 由于 send 任务带有 `group-task:sent:${type}:${date}[:timeSlot]:${groupId}` 的日内幂等键，
   * 已发送成功的群不会被重发；失败的群会走新一轮 attempts + backoff。
   */
  @Post('retry/:type')
  async retry(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    const failedJobs = (await this.groupTaskQueue.getFailed()) as AnyGroupTaskJob[];
    const targetJobs = failedJobs.filter(
      (job) => job.name === GroupTaskJobName.SEND && this.matchesType(job, type),
    );

    const retried: Array<{ jobId: string; groupName: string }> = [];
    const errors: Array<{ jobId: string; error: string }> = [];
    for (const job of targetJobs) {
      try {
        await job.retry();
        const data = job.data as SendJobData;
        retried.push({
          jobId: String(job.id),
          groupName: data.group.groupName,
        });
      } catch (error) {
        errors.push({
          jobId: String(job.id),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      success: errors.length === 0,
      type,
      retriedCount: retried.length,
      failedToRetryCount: errors.length,
      retried,
      errors,
    };
  }

  /**
   * 查询某类型当前队列状态（粗粒度聚合 + 可选详情）。
   * 供 dashboard 判断"今天到底发到哪一步了 / 还有多少待发"。
   */
  @Get('status/:type')
  async status(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    const [waiting, active, delayed, failed, completed] = await Promise.all([
      this.groupTaskQueue.getWaiting() as Promise<AnyGroupTaskJob[]>,
      this.groupTaskQueue.getActive() as Promise<AnyGroupTaskJob[]>,
      this.groupTaskQueue.getDelayed() as Promise<AnyGroupTaskJob[]>,
      this.groupTaskQueue.getFailed() as Promise<AnyGroupTaskJob[]>,
      this.groupTaskQueue.getCompleted() as Promise<AnyGroupTaskJob[]>,
    ]);

    const filter = (jobs: AnyGroupTaskJob[]) => jobs.filter((job) => this.matchesType(job, type));

    const byJobName = (jobs: AnyGroupTaskJob[]) =>
      jobs.reduce<Record<string, number>>((acc, job) => {
        acc[job.name] = (acc[job.name] ?? 0) + 1;
        return acc;
      }, {});

    return {
      type,
      counts: {
        waiting: filter(waiting).length,
        active: filter(active).length,
        delayed: filter(delayed).length,
        failed: filter(failed).length,
        completed: filter(completed).length,
      },
      byJobName: {
        waiting: byJobName(filter(waiting)),
        active: byJobName(filter(active)),
        delayed: byJobName(filter(delayed)),
        failed: byJobName(filter(failed)),
      },
      failedSendGroups: filter(failed)
        .filter((j) => j.name === GroupTaskJobName.SEND)
        .map((j) => ({
          jobId: String(j.id),
          groupName: (j.data as SendJobData).group.groupName,
          failedReason: j.failedReason,
          attemptsMade: j.attemptsMade,
        })),
    };
  }

  /**
   * 测试端点：向指定群发送模拟群任务通知
   *
   * 从已配置的小组 token 中查找目标群（按群名匹配），
   * 运行策略的完整流程（fetchData → 生成消息 → 发送）。
   * 不走 Bull，直接同步执行便于调试。
   */
  @Post('test-send')
  async testSend(
    @Body()
    body: {
      type: GroupTaskType;
      groupName: string;
      city?: string;
      industry?: string;
      forceSend?: boolean;
    },
  ) {
    const { type, groupName, city = '上海', industry = '餐饮', forceSend = false } = body;

    if (!type || !groupName) {
      throw new HttpException('type 和 groupName 必填', HttpStatus.BAD_REQUEST);
    }

    const strategy = this.scheduler.getStrategy(type);
    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const targetGroup = await this.groupResolver.findGroupByName(groupName);
    if (!targetGroup) {
      return {
        success: false,
        error: `未找到群: ${groupName}`,
        hint: '确保目标群在已配置的小组 token 中（GROUP_TASK_TOKENS）',
      };
    }

    const testContext: GroupContext = {
      ...targetGroup,
      city,
      industry,
    };

    const data = await strategy.fetchData(testContext);
    if (!data.hasData) {
      return {
        success: false,
        error: '策略无数据可推送',
        summary: data.summary,
        context: { city, industry, groupName: targetGroup.groupName },
      };
    }

    let message: string;
    if (strategy.needsAI && strategy.buildPrompt) {
      const prompt = strategy.buildPrompt(data, testContext);
      message = await this.completionService.generateSimple({
        systemPrompt: prompt.systemPrompt,
        userMessage: prompt.userMessage,
      });
      if (strategy.appendFooter) {
        message = strategy.appendFooter(message, data);
      }
    } else if (strategy.buildMessage) {
      message = strategy.buildMessage(data, testContext);
    } else {
      throw new HttpException(
        '策略未实现 buildMessage 或 buildPrompt',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    const dryRun = !forceSend;
    await this.notificationSender.sendToGroup(targetGroup, message, type, dryRun);

    const followUpMessage = data.payload?.followUpMessage as string | undefined;
    if (followUpMessage) {
      await this.notificationSender.sendTextToGroup(targetGroup, followUpMessage, dryRun);
    }

    return {
      success: true,
      dryRun,
      groupName: targetGroup.groupName,
      city,
      industry,
      type,
      dataSummary: data.summary,
      message,
      followUpMessage,
    };
  }

  // ==================== 内部工具 ====================

  /** 判断 job 是否属于指定 type（plan/prepare/send/summarize 都在 data.type 里） */
  private matchesType(job: AnyGroupTaskJob, type: GroupTaskType): boolean {
    const data = job.data as { type?: GroupTaskType } | undefined;
    return data?.type === type;
  }
}
