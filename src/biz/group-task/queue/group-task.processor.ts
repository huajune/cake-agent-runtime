import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Job, Queue } from 'bull';
import { CompletionService } from '@agent/completion.service';
import { RedisService } from '@infra/redis/redis.service';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';
import {
  GROUP_TASK_CACHE_TTL_SECONDS,
  GROUP_TASK_IDEMPOTENCY_TTL_SECONDS,
  GROUP_TASK_QUEUE_NAME,
  GroupTaskJobName,
  GroupTaskMessageCache,
  GroupTaskMetaSnapshot,
  GroupTaskResultSnapshot,
  PlanJobData,
  PrepareJobData,
  SendJobData,
  SendTarget,
  SummarizeJobData,
  groupTaskDailySentKey,
  groupTaskMetaKey,
  groupTaskMsgKey,
  groupTaskResultKey,
} from './group-task-queue.constants';
import {
  GroupContext,
  GroupExecutionDetail,
  GroupTaskType,
  TaskExecutionResult,
} from '../group-task.types';
import { GroupResolverService } from '../services/group-resolver.service';
import { NotificationSenderService } from '../services/notification-sender.service';
import { BrandRotationService } from '../services/brand-rotation.service';
import { OrderGrabStrategy } from '../strategies/order-grab.strategy';
import { PartTimeJobStrategy } from '../strategies/part-time-job.strategy';
import { StoreManagerStrategy } from '../strategies/store-manager.strategy';
import { WorkTipsStrategy } from '../strategies/work-tips.strategy';
import { NotificationStrategy } from '../strategies/notification.strategy';

/**
 * 群任务队列处理器
 *
 * 单个 Bull Queue 承载四类 Job（plan / prepare / send / summarize），
 * 串联起"分组 → 生成消息 → 单群幂等发送 → 汇总"的持久化链路。
 * 任何阶段进程崩溃，Bull 自带 stalled recovery 都会把任务迁回 waiting，
 * 新进程起来后自动续跑，避免整次推送在部署窗口里被"腰斩"。
 */
@Injectable()
export class GroupTaskProcessor implements OnModuleInit {
  private readonly logger = new Logger(GroupTaskProcessor.name);

  private readonly strategies: Record<GroupTaskType, NotificationStrategy>;

  constructor(
    @InjectQueue(GROUP_TASK_QUEUE_NAME) private readonly queue: Queue,
    private readonly completionService: CompletionService,
    private readonly redisService: RedisService,
    private readonly groupResolver: GroupResolverService,
    private readonly notificationSender: NotificationSenderService,
    private readonly brandRotation: BrandRotationService,
    private readonly orderGrabStrategy: OrderGrabStrategy,
    private readonly partTimeJobStrategy: PartTimeJobStrategy,
    private readonly storeManagerStrategy: StoreManagerStrategy,
    private readonly workTipsStrategy: WorkTipsStrategy,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {
    this.strategies = {
      [GroupTaskType.ORDER_GRAB]: this.orderGrabStrategy,
      [GroupTaskType.PART_TIME_JOB]: this.partTimeJobStrategy,
      [GroupTaskType.STORE_MANAGER]: this.storeManagerStrategy,
      [GroupTaskType.WORK_TIPS]: this.workTipsStrategy,
    };
  }

  async onModuleInit(): Promise<void> {
    await this.waitForQueueReady();
    this.registerWorkers();
    this.setupQueueEventListeners();
    this.logger.log('[群任务队列] 处理器已初始化');
  }

  // ==================== Worker 注册 ====================

  private registerWorkers(): void {
    this.queue.process(GroupTaskJobName.PLAN, 1, (job: Job<PlanJobData>) => this.handlePlan(job));
    this.queue.process(GroupTaskJobName.PREPARE, 3, (job: Job<PrepareJobData>) =>
      this.handlePrepare(job),
    );
    // send 单 worker，防止同一 bot 并发发出触发风控；单群之间通过 delay 天然错峰
    this.queue.process(GroupTaskJobName.SEND, 1, (job: Job<SendJobData>) => this.handleSend(job));
    this.queue.process(GroupTaskJobName.SUMMARIZE, 1, (job: Job<SummarizeJobData>) =>
      this.handleSummarize(job),
    );
    this.logger.log('[群任务队列] Worker 已注册');
  }

  private setupQueueEventListeners(): void {
    this.queue.on('failed', (job: Job, error: Error) => {
      this.logger.error(
        `[群任务队列] ❌ ${job.name} job=${job.id} 失败 (attempts=${job.attemptsMade}/${job.opts.attempts ?? 1}): ${error.message}`,
      );
    });
    this.queue.on('stalled', (job: Job) => {
      this.logger.warn(
        `[群任务队列] ⚠️ ${job.name} job=${job.id} 被标记 stalled，将由 Bull 重新派发`,
      );
    });
  }

  private waitForQueueReady(): Promise<void> {
    const maxWaitTime = 30_000;
    const checkInterval = 100;
    const startTime = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (this.queue.client?.status === 'ready') {
          this.logger.log('[群任务队列] Redis client 已就绪');
          resolve();
          return;
        }
        if (Date.now() - startTime > maxWaitTime) {
          this.logger.warn('[群任务队列] Redis client 就绪超时，继续运行');
          resolve();
          return;
        }
        setTimeout(tick, checkInterval);
      };
      tick();
    });
  }

  // ==================== Plan ====================

  private async handlePlan(job: Job<PlanJobData>): Promise<void> {
    const { execId, type, timeSlot, dryRun, sendDelayMs, startedAt, trigger } = job.data;
    const strategy = this.strategies[type];
    if (!strategy) {
      throw new Error(`[plan] 未知任务类型: ${type}`);
    }

    this.logger.log(`[plan] 开始排程 type=${type} exec=${execId} trigger=${trigger}`);

    const groups = await this.groupResolver.resolveGroups(strategy.tagPrefix);
    if (groups.length === 0) {
      this.logger.warn(`[plan] 未找到匹配群 (tagPrefix=${strategy.tagPrefix})`);
      const emptyMeta: GroupTaskMetaSnapshot = {
        execId,
        type,
        timeSlot,
        dryRun,
        totalGroups: 0,
        groupIds: [],
        startedAt,
        trigger,
      };
      await this.redisService.setex(
        groupTaskMetaKey(execId),
        GROUP_TASK_CACHE_TTL_SECONDS,
        emptyMeta,
      );
      await this.enqueueSummarize(emptyMeta, 0);
      return;
    }

    if (strategy.prepareTask) {
      await strategy.prepareTask({ timeSlot });
    }

    const groupMap =
      type === GroupTaskType.ORDER_GRAB
        ? this.groupOrderGrabGroups(groups)
        : this.groupByCityIndustry(groups);

    const execDate = formatShanghaiDate(startedAt);
    let globalIndex = 0;
    const prepareJobs: PrepareJobData[] = [];
    const groupIds: string[] = [];
    for (const [groupKey, members] of groupMap) {
      const targets: SendTarget[] = members.map((group) => ({
        group,
        globalIndex: globalIndex++,
      }));
      targets.forEach(({ group }) => groupIds.push(group.imRoomId));
      prepareJobs.push({
        execId,
        type,
        timeSlot,
        dryRun,
        groupKey,
        targets,
        totalGroups: groups.length,
        sendDelayMs,
        execDate,
      });
    }

    const meta: GroupTaskMetaSnapshot = {
      execId,
      type,
      timeSlot,
      dryRun,
      totalGroups: groups.length,
      groupIds,
      startedAt,
      trigger,
    };
    await this.redisService.setex(groupTaskMetaKey(execId), GROUP_TASK_CACHE_TTL_SECONDS, meta);

    for (const prepareJob of prepareJobs) {
      await this.queue.add(GroupTaskJobName.PREPARE, prepareJob, {
        jobId: `${execId}:prepare:${prepareJob.groupKey}`,
        attempts: 3,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
      });
    }

    // 预估整次 exec 耗时：最后一个 send 的 delay + 单群发送耗时 + 安全缓冲
    const tailSendDelayMs = Math.max(0, groups.length - 1) * sendDelayMs;
    const summarizeDelayMs = tailSendDelayMs + sendDelayMs * 5 + 30_000;
    await this.enqueueSummarize(meta, summarizeDelayMs);

    this.logger.log(
      `[plan] exec=${execId} 已排程 ${groups.length} 个群，${groupMap.size} 个分组，summarize delay=${summarizeDelayMs}ms`,
    );
  }

  private async enqueueSummarize(meta: GroupTaskMetaSnapshot, delayMs: number): Promise<void> {
    const data: SummarizeJobData = {
      execId: meta.execId,
      type: meta.type,
      timeSlot: meta.timeSlot,
      dryRun: meta.dryRun,
      totalGroups: meta.totalGroups,
      startedAt: meta.startedAt,
      groupIds: meta.groupIds,
    };
    await this.queue.add(GroupTaskJobName.SUMMARIZE, data, {
      jobId: `${meta.execId}:summarize`,
      delay: delayMs,
      attempts: 2,
      backoff: { type: 'fixed', delay: 30_000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60, count: 500 },
      removeOnFail: { age: 7 * 24 * 60 * 60, count: 500 },
    });
  }

  // ==================== Prepare ====================

  private async handlePrepare(job: Job<PrepareJobData>): Promise<void> {
    const {
      execId,
      type,
      timeSlot,
      dryRun,
      groupKey,
      targets,
      totalGroups,
      sendDelayMs,
      execDate,
    } = job.data;
    const strategy = this.strategies[type];
    if (!strategy) {
      throw new Error(`[prepare] 未知任务类型: ${type}`);
    }
    if (targets.length === 0) return;

    const representative = targets[0].group;
    const notificationData = await strategy.fetchData(representative, timeSlot);

    if (!notificationData.hasData) {
      this.logger.log(
        `[prepare] 跳过分组 [${groupKey}] (${targets.length}群): ${notificationData.summary}`,
      );
      for (const { group } of targets) {
        await this.writeGroupResult(execId, group.imRoomId, {
          groupKey,
          groupName: group.groupName,
          status: 'skipped',
          summary: notificationData.summary,
          updatedAt: Date.now(),
        });
      }
      return;
    }

    let message: string;
    if (strategy.needsAI && strategy.buildPrompt) {
      const prompt = strategy.buildPrompt(notificationData, representative);
      message = await this.completionService.generateSimple({
        systemPrompt: prompt.systemPrompt,
        userMessage: prompt.userMessage,
      });
      if (strategy.appendFooter) {
        message = strategy.appendFooter(message, notificationData);
      }
    } else if (strategy.buildMessage) {
      message = strategy.buildMessage(notificationData, representative, timeSlot);
    } else {
      throw new Error(`[prepare] 策略 ${type} 未实现 buildMessage 或 buildPrompt`);
    }

    const followUpMessage = notificationData.payload?.followUpMessage as string | undefined;
    const brand = notificationData.payload?.brand as string | undefined;

    const msgRedisKey = groupTaskMsgKey(execId, groupKey);
    const cache: GroupTaskMessageCache = {
      message,
      followUpMessage,
      brand,
      summary: notificationData.summary,
    };
    await this.redisService.setex(msgRedisKey, GROUP_TASK_CACHE_TTL_SECONDS, cache);

    for (const { group, globalIndex } of targets) {
      const sendJob: SendJobData = {
        execId,
        type,
        timeSlot,
        dryRun,
        group,
        groupKey,
        msgRedisKey,
        execDate,
        totalGroups,
      };
      await this.queue.add(GroupTaskJobName.SEND, sendJob, {
        jobId: `${execId}:send:${group.imRoomId}`,
        delay: globalIndex * sendDelayMs,
        attempts: 3,
        backoff: { type: 'exponential', delay: 15_000 },
        removeOnComplete: { age: 7 * 24 * 60 * 60, count: 1000 },
        removeOnFail: { age: 7 * 24 * 60 * 60, count: 1000 },
      });
    }

    this.logger.log(
      `[prepare] exec=${execId} 分组 [${groupKey}] 消息已生成，${targets.length} 个 Send 已排程`,
    );
  }

  // ==================== Send ====================

  private async handleSend(job: Job<SendJobData>): Promise<void> {
    const { execId, type, dryRun, group, groupKey, msgRedisKey, execDate, timeSlot } = job.data;

    // 幂等守护：跨 exec、跨重试共享。只在"成功后"写入，失败留白可重试。
    const dailyKey = groupTaskDailySentKey(type, execDate, timeSlot, group.imRoomId);
    const alreadySent = await this.redisService.exists(dailyKey);
    if (alreadySent) {
      this.logger.log(`[send] 已发送，跳过: ${group.groupName}`);
      await this.writeGroupResult(execId, group.imRoomId, {
        groupKey,
        groupName: group.groupName,
        status: 'skipped',
        summary: '今日已发送（幂等跳过）',
        updatedAt: Date.now(),
      });
      return;
    }

    const cache = await this.redisService.get<GroupTaskMessageCache>(msgRedisKey);
    if (!cache) {
      throw new Error(`[send] 消息缓存丢失，无法发送 ${group.groupName}: ${msgRedisKey}`);
    }

    try {
      await this.notificationSender.sendToGroup(group, cache.message, type, dryRun);
      if (cache.followUpMessage) {
        await this.notificationSender.sendTextToGroup(group, cache.followUpMessage, dryRun);
      }

      // 先写幂等 key 再记录品牌轮转 / 结果，降低重复发送概率
      await this.redisService.setex(dailyKey, GROUP_TASK_IDEMPOTENCY_TTL_SECONDS, '1');

      if (type === GroupTaskType.PART_TIME_JOB && cache.brand) {
        await this.brandRotation.recordPushedBrand(group.imRoomId, cache.brand);
      }

      await this.writeGroupResult(execId, group.imRoomId, {
        groupKey,
        groupName: group.groupName,
        status: 'sent',
        summary: cache.summary,
        updatedAt: Date.now(),
      });

      this.logger.log(`[send] ✅ ${group.groupName}`);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[send] ❌ ${group.groupName}: ${errorMsg}`);
      await this.writeGroupResult(execId, group.imRoomId, {
        groupKey,
        groupName: group.groupName,
        status: 'failed',
        summary: '发送失败',
        error: errorMsg,
        updatedAt: Date.now(),
      });
      throw error;
    }
  }

  // ==================== Summarize ====================

  private async handleSummarize(job: Job<SummarizeJobData>): Promise<void> {
    const { execId, type, timeSlot, dryRun, totalGroups, startedAt, groupIds } = job.data;

    const results: GroupTaskResultSnapshot[] = [];
    for (const groupId of groupIds) {
      const snapshot = await this.redisService.get<GroupTaskResultSnapshot>(
        groupTaskResultKey(execId, groupId),
      );
      if (snapshot) {
        results.push(snapshot);
      } else {
        // 没有结果记录的群（summarize 触发时还未跑完）标记为失败，避免静默遗漏
        results.push({
          groupKey: 'unknown',
          groupName: groupId,
          status: 'failed',
          summary: '未收到发送结果（可能仍在重试或消息缓存过期）',
          updatedAt: Date.now(),
        });
      }
    }

    const result = this.aggregateResults({
      type,
      totalGroups,
      startedAt,
      results,
    });

    try {
      await this.notificationSender.reportToFeishu(result, dryRun);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      this.logger.error(`[summarize] 飞书汇总失败 exec=${execId}: ${errorMsg}`);
      this.exceptionNotifier?.notifyAsync({
        source: {
          subsystem: 'group-task',
          component: 'GroupTaskProcessor',
          action: 'summarize',
          trigger: 'manual',
        },
        code: 'group_task.summary_failed',
        summary: `${type} 汇总上报失败 exec=${execId}`,
        error,
        severity: AlertLevel.ERROR,
        scope: { scenario: type },
        diagnostics: { payload: { execId, dryRun, timeSlot } },
      });
      throw error;
    }

    this.logger.log(
      `[summarize] exec=${execId} 完成：成功=${result.successCount} 失败=${result.failedCount} 跳过=${result.skippedCount}`,
    );
  }

  // ==================== 内部工具 ====================

  private async writeGroupResult(
    execId: string,
    groupId: string,
    snapshot: GroupTaskResultSnapshot,
  ): Promise<void> {
    await this.redisService.setex(
      groupTaskResultKey(execId, groupId),
      GROUP_TASK_CACHE_TTL_SECONDS,
      snapshot,
    );
  }

  private aggregateResults(params: {
    type: GroupTaskType;
    totalGroups: number;
    startedAt: number;
    results: GroupTaskResultSnapshot[];
  }): TaskExecutionResult {
    const { type, totalGroups, startedAt, results } = params;

    const successCount = results.filter((r) => r.status === 'sent').length;
    const failedCount = results.filter((r) => r.status === 'failed').length;
    const skippedCount = results.filter((r) => r.status === 'skipped').length;

    const errors = results
      .filter((r) => r.status === 'failed')
      .map((r) => ({ groupName: r.groupName, error: r.error ?? '未知错误' }));

    // 按 groupKey 聚合 details（与原格式兼容）
    const detailMap = new Map<
      string,
      GroupExecutionDetail & { groupResults: GroupTaskResultSnapshot[] }
    >();
    for (const r of results) {
      const existing = detailMap.get(r.groupKey);
      if (existing) {
        existing.groupCount++;
        existing.groupNames.push(r.groupName);
        existing.groupResults.push(r);
      } else {
        detailMap.set(r.groupKey, {
          groupKey: r.groupKey,
          groupCount: 1,
          dataSummary: r.summary,
          status: 'failed',
          groupNames: [r.groupName],
          groupResults: [r],
        });
      }
    }

    const details: GroupExecutionDetail[] = [];
    for (const detail of detailMap.values()) {
      const allSent = detail.groupResults.every((r) => r.status === 'sent');
      const allSkipped = detail.groupResults.every((r) => r.status === 'skipped');
      const anySent = detail.groupResults.some((r) => r.status === 'sent');
      const status: GroupExecutionDetail['status'] = allSent
        ? 'success'
        : allSkipped
          ? 'skipped'
          : anySent
            ? 'partial'
            : 'failed';
      details.push({
        groupKey: detail.groupKey,
        groupCount: detail.groupCount,
        dataSummary: detail.dataSummary,
        status,
        groupNames: detail.groupNames,
      });
    }

    return {
      type,
      totalGroups,
      successCount,
      failedCount,
      skippedCount,
      errors,
      details,
      startTime: new Date(startedAt),
      endTime: new Date(),
    };
  }

  private groupByCityIndustry(groups: GroupContext[]): Map<string, GroupContext[]> {
    const map = new Map<string, GroupContext[]>();
    for (const group of groups) {
      const key = group.industry ? `${group.city}_${group.industry}` : group.city;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(group);
    }
    return map;
  }

  private groupOrderGrabGroups(groups: GroupContext[]): Map<string, GroupContext[]> {
    const map = new Map<string, GroupContext[]>();
    const strategy = this.orderGrabStrategy as OrderGrabStrategy & {
      resolveOrderGrabGroupKey?: (context: GroupContext) => string;
    };
    for (const group of groups) {
      const key = strategy.resolveOrderGrabGroupKey?.(group) ?? group.city;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(group);
    }
    return map;
  }
}

/**
 * 以上海时区格式化日期（YYYYMMDD），用作日内幂等键的日期段。
 */
function formatShanghaiDate(tsMs: number): string {
  const d = new Date(tsMs);
  const shanghai = new Date(d.getTime() + (8 * 60 - d.getTimezoneOffset()) * 60_000);
  const y = shanghai.getUTCFullYear();
  const m = String(shanghai.getUTCMonth() + 1).padStart(2, '0');
  const day = String(shanghai.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
