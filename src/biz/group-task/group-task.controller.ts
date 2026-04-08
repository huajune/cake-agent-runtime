import {
  Controller,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
  ParseEnumPipe,
  Logger,
  HttpCode,
} from '@nestjs/common';
import { ApiTokenGuard } from '@infra/server/guards/api-token.guard';
import { GroupTaskSchedulerService } from './services/group-task-scheduler.service';
import { GroupResolverService } from './services/group-resolver.service';
import { NotificationSenderService } from './services/notification-sender.service';
import { CompletionService } from '@agent/completion.service';
import { GroupTaskType, GroupContext } from './group-task.types';

/**
 * 群任务 Controller
 *
 * 手动触发通知任务（调试用）。
 * 配置管理已合并到 /config/agent-config 和 /config/group-task-config。
 * 显式声明 ApiTokenGuard，防止全局 Guard 配置变更时意外暴露。
 */
@UseGuards(ApiTokenGuard)
@Controller('group-task')
export class GroupTaskController {
  private readonly logger = new Logger(GroupTaskController.name);

  constructor(
    private readonly scheduler: GroupTaskSchedulerService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly completionService: CompletionService,
  ) {}

  /**
   * 手动触发指定类型的通知任务（异步，立即返回）
   *
   * POST /group-task/trigger/:type
   * type: order_grab | part_time | store_manager | work_tips
   *
   * forceEnabled=true 绕过 enabled 开关（即使定时任务关闭也能执行），
   * 但仍遵守 DB 中的 dryRun 设置（试运行时只发飞书不发企微）。
   *
   * 语义：fire-and-forget。任务被接受后立刻返回 202，实际进度/结果通过
   * 飞书「消息通知群」反馈（每个群的预览卡片 + 最终的聚合报告）。
   * 前端不再同步等待（原来会等 20~60s 导致超时误报失败）。
   */
  @Post('trigger/:type')
  @HttpCode(HttpStatus.ACCEPTED)
  trigger(@Param('type', new ParseEnumPipe(GroupTaskType)) type: GroupTaskType) {
    const strategy = this.scheduler.getStrategy(type);

    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 异步执行，不阻塞 HTTP 响应。executeTask 内部已有完整 try/catch 与飞书结果上报，
    // 这里的 .catch 只是兜底防止 unhandled rejection（理论上不会走到）。
    this.scheduler.executeTask(strategy, { forceEnabled: true }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${type}] 手动触发任务执行异常（预期不会走到）: ${message}`);
    });

    return {
      type,
      status: 'accepted',
      message: '任务已触发，执行进度与结果将通过飞书通知群反馈',
    };
  }

  /**
   * 测试端点：向指定群发送模拟群任务通知
   *
   * POST /group-task/test-send
   * Body: { type, groupName, city?, industry?, forceSend? }
   *
   * 从已配置的小组 token 中查找目标群（按群名匹配），
   * 运行策略的完整流程（fetchData → 生成消息 → 发送）。
   */
  @Post('test-send')
  async testSend(
    @Body()
    body: {
      /** 任务类型 */
      type: GroupTaskType;
      /** 目标群名称（精确匹配） */
      groupName: string;
      /** 模拟城市（默认 '上海'） */
      city?: string;
      /** 模拟行业（默认 '餐饮'） */
      industry?: string;
      /** 强制发送到企微（默认 false，只发飞书预览） */
      forceSend?: boolean;
    },
  ) {
    const { type, groupName, city = '上海', industry = '餐饮', forceSend = false } = body;

    if (!type || !groupName) {
      throw new HttpException('type 和 groupName 必填', HttpStatus.BAD_REQUEST);
    }

    // 1. 获取策略
    const strategy = this.scheduler.getStrategy(type);
    if (!strategy) {
      throw new HttpException(
        `未知的任务类型: ${type}，可选值: ${Object.values(GroupTaskType).join(', ')}`,
        HttpStatus.BAD_REQUEST,
      );
    }

    // 2. 按群名搜索任意群（不要求有标签）
    const targetGroup = await this.groupResolver.findGroupByName(groupName);
    if (!targetGroup) {
      return {
        success: false,
        error: `未找到群: ${groupName}`,
        hint: '确保目标群在已配置的小组 token 中（GROUP_TASK_TOKENS）',
      };
    }

    // 3. 覆盖城市/行业（测试用）
    const testContext: GroupContext = {
      ...targetGroup,
      city,
      industry,
    };

    // 4. 执行策略：fetchData → 生成消息
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

    // 5. 发送（forceSend=false 时相当于 dryRun，只发飞书预览）
    const dryRun = !forceSend;
    await this.notificationSender.sendToGroup(targetGroup, message, type, dryRun);

    // 6. 跟随消息（如店长群问候语）单独发送
    const followUpMessage = data.payload?.followUpMessage as string | undefined;
    if (followUpMessage) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
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
}
