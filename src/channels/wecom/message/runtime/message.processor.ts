import { ReplyDeferredError } from '@biz/reply-execution/reply-execution.types';
import { QueueFailureService } from '@infra/queue/queue-failure.service';
import { CandidateBlacklistFilterRule } from '../application/filter-rules/message-filter.rules';
import { toErrorMessage } from '@infra/utils/error.util';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { resolveBullPrefix } from '@infra/queue/bull.module';
import { createMessageWorkerConsumer } from './message-worker-consumer';
import { ConfigService } from '@nestjs/config';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { FilterReason } from '@enums/message-filter.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { SimpleMergeService } from './simple-merge.service';
import { MessageDeduplicationService } from './deduplication.service';
import { MessagePipelineService } from '../application/pipeline.service';
import { MessageWorkerManagerService } from './message-worker-manager.service';
import { ACTION_DENIAL_REASON, PERMITTED_ACTION } from '@shared-types/action-permit.types';

/**
 * Bull 'process' 任务消费者（Job 由 SimpleMergeService 创建）。
 *
 * 职责：per-chat 处理锁（90s 租约+心跳）→ 静默窗口复查 → pending 快照 →
 * 托管暂停复查 → 委托 MessagePipelineService；含 SIGTERM 优雅排空。
 * 直接依赖回复工作流编排，而非反向依赖入口服务。
 */
@Injectable()
export class MessageProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MessageProcessor.name);

  private readonly drainTimeoutMs: number;

  constructor(
    @InjectQueue('message-merge') private readonly messageQueue: Queue,
    private readonly messagePipeline: MessagePipelineService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly workerManager: MessageWorkerManagerService,
    private readonly actionPermit: ActionPermitService,
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly messageTracking: MessageTrackingService,
    private readonly configService: ConfigService,
    private readonly chatSession: ChatSessionService,
    private readonly queueFailures: QueueFailureService,
    private readonly blacklistFilter: CandidateBlacklistFilterRule,
  ) {
    this.drainTimeoutMs = parseInt(
      this.configService.get('SHUTDOWN_DRAIN_TIMEOUT_MS', '60000'),
      10,
    );
  }

  async onModuleInit() {
    await this.workerManager.initialize(
      (concurrency) =>
        createMessageWorkerConsumer(
          this.messageQueue,
          resolveBullPrefix(this.configService),
          concurrency,
          (worker) => this.setupQueueEventListeners(worker),
        ),
      (job) => this.handleProcessJob(job),
    );
  }

  /**
   * 发版/重启收到 SIGTERM 时优雅排空（需 main.ts 开启 enableShutdownHooks）。
   *
   * queue.close() 默认会先停止领取新任务，再等待 active 任务执行完成——让正在
   * 调 Agent / 投递中的消息走完整个流程（含 ack pending 与终态落库），而不是被
   * 半路杀死后永久卡在 processing（v5.13.0 发版事故）。
   *
   * 超过 drainTimeoutMs 仍未排空则放弃等待：此时未 ack 的 pending 保留在 Redis，
   * 锁冲突重检机制会让新实例接手重放，不能为等待拖垮部署平台的强杀窗口。
   */
  async onModuleDestroy(): Promise<void> {
    this.logger.log(
      `[Shutdown] 停止领取新任务，等待 in-flight 消息处理完成（最长 ${this.drainTimeoutMs}ms）...`,
    );

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        this.workerManager
          .stop()
          .then(() => this.messageQueue.close())
          .then(() => 'drained' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), this.drainTimeoutMs);
        }),
      ]);

      if (result === 'drained') {
        this.logger.log('[Shutdown] ✅ 队列已排空并关闭');
      } else {
        this.logger.warn(
          `[Shutdown] ⚠️ ${this.drainTimeoutMs}ms 内仍有任务未完成，放弃等待（未 ack 的 pending 将由新实例重放）`,
        );
      }
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.warn(`[Shutdown] 排空队列失败: ${errorMessage}`);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private setupQueueEventListeners(consumer: Queue): void {
    consumer.on('error', (error: Error) =>
      this.logger.error(`[Bull] 消费者连接异常: ${toErrorMessage(error)}`),
    );
    consumer.on('completed', (job: Job) => {
      this.logger.log(`[Bull] ✅ 任务 ${job.id} 完成`);
    });

    consumer.on('failed', (job: Job, error: Error) => {
      this.logger.error(`[Bull] ❌ 任务 ${job.id} 失败: ${error.message}`);
      void this.queueFailures.exhausted('message-merge', job, error);
    });

    consumer.on('active', (job: Job) => {
      this.logger.log(`[Bull] 🔄 任务 ${job.id} 开始处理`);
    });

    consumer.on('stalled', (job: Job) => {
      this.logger.warn(`[Bull] ⚠️ 任务 ${job.id} 卡住（stalled）`);
    });
  }

  /**
   * 处理队列任务
   * 任务数据只包含 chatId，消息从 Redis 获取
   */
  private async handleProcessJob(job: Job<{ chatId: string }>) {
    const { chatId } = job.data;
    const lockOwner = `job:${job.id}:${Date.now()}`;
    let lockAcquired = false;
    let stopLockHeartbeat: (() => void) | undefined;

    try {
      lockAcquired = await this.simpleMergeService.acquireProcessingLock(chatId, lockOwner);
      if (!lockAcquired) {
        this.logger.debug(`[Bull] chatId=${chatId} 已有任务在处理中，跳过当前任务 ${job.id}`);
        // 持锁进程可能已被发版重启杀死（孤悬锁最长存活到 TTL 过期），若只是静默
        // 跳过，pending 会跟着自身 TTL 过期、消息永久丢失。补建延迟重检任务并
        // 续期 pending，确保锁过期后仍有任务接手。
        await this.simpleMergeService.scheduleLockRetryCheck(chatId);
        return;
      }

      // 锁是短租约（90s）+ 处理期间心跳续期：长 Agent 调用靠续期不丢锁，
      // 进程崩溃后孤悬锁最长一个租约即让位（固定长 TTL 会拖长让位时间）。
      stopLockHeartbeat = this.simpleMergeService.startLockHeartbeat(chatId, lockOwner);

      this.logger.log(`[Bull] 开始处理任务 ${job.id}, chatId: ${chatId}`);

      const quietWindowElapsed = await this.simpleMergeService.isQuietWindowElapsed(chatId);
      if (!quietWindowElapsed) {
        // Bull delayed job 可能被提前唤醒，或对应最后一条消息的检查任务已丢失。旧逻辑
        // 直接 return，假设“后面总有另一条 job”，当用户不再发消息时 pending 会静默过期。
        // 现在显式补建剩余窗口后的检查；补建失败上抛，让 Bull failed/retry 可观测。
        await this.simpleMergeService.scheduleQuietWindowRetryCheck(chatId);
        this.logger.debug(
          `[Bull] chatId=${chatId} 静默窗口未结束，已补建剩余窗口检查任务 ${job.id}`,
        );
        return;
      }

      // 只读取快照，终态后按原消息 ID 确认；列表过期重建后也不能裁掉新输入。
      const { messages, batchId } = await this.simpleMergeService.claimPendingSnapshot(chatId);

      if (messages.length === 0) {
        this.logger.debug(`[Bull] 任务 ${job.id} 没有待处理消息，跳过`);
        return;
      }

      // 入口 PausedUserFilterRule 在消息进入 debounce 静默窗口前已经过一次
      // isUserPaused，但运营在静默窗口内点关托管时，已入队的 batch 会绕过入口
      // 检查直接落到这里。worker 拉起后再复查一次：命中即丢弃整批，避免穿透
      // 到 Agent 投递（1tsdimfg badcase）。
      if (await this.dropIfHostingPaused(chatId, messages, job.id)) {
        await this.simpleMergeService.ackPendingMessageIds(
          chatId,
          messages.map((message) => message.messageId),
        );
        return;
      }

      // 处理消息
      const result = await this.messagePipeline.processMergedMessages(
        messages,
        batchId,
        async () => {
          if (!(await this.simpleMergeService.renewProcessingLock(chatId, lockOwner)))
            throw new ReplyDeferredError('conversation_lease_lost');
        },
      );
      if (result === 'deferred') {
        await this.simpleMergeService.scheduleLockRetryCheck(chatId);
        return;
      }

      // 处理完后若又收到了新消息，则按“最后一条消息后的静默窗口”补建下一轮检查任务
      await this.simpleMergeService.checkAndProcessNewMessages(chatId);
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      this.logger.error(`[Bull] 任务 ${job.id} 处理失败: ${errorMessage}`);
      throw error;
    } finally {
      stopLockHeartbeat?.();
      if (lockAcquired) {
        await this.simpleMergeService.releaseProcessingLock(chatId, lockOwner).catch((error) => {
          const errorMessage = toErrorMessage(error);
          this.logger.warn(`[Bull] 释放 chatId=${chatId} 处理锁失败: ${errorMessage}`);
        });
      }
    }
  }

  /**
   * 静默窗口期内运营关托管 → drain 出来的 batch 命中暂停时直接丢弃。
   *
   * 同时把每条 messageId 标记为已处理（与 historyOnly 路径对齐），避免回调
   * 重试时再次进入 debounce 队列。
   *
   * 并回收这批消息在 intake 时写下的 processing 流水：
   * 本批不会再进入 Agent，也就永远不会有终态回写，行会一直停在 processing 直到
   * 03:00 UTC cron 标 timeout。这不影响候选人（本就该由真人接），但污染观测口径
   * ——processing 被当作"真在处理"计数。复用聚合路径既有的回收语义（删除源行 +
   * 扣减 activeRequests），不新增状态机。
   *
   * 这批消息入站时已按正常路径入库，这里补记 history_only_reason=user-paused，
   * 与入站即命中暂停的消息同口径：复聊据此识别「转给真人处理」，不当作主链丢消息。
   */
  private async dropIfHostingPaused(
    chatId: string,
    messages: EnterpriseMessageCallbackDto[],
    jobId: string | number,
  ): Promise<boolean> {
    const primary = messages[messages.length - 1];
    const hit = await this.actionPermit.evaluate({
      chatId,
      action: PERMITTED_ACTION.REPLY,
      botImId: primary.imBotId,
      groupId: primary.groupId,
      candidateIds: [primary.imContactId, primary.externalUserId],
    });
    if (hit.allowed) return false;
    if (hit.reason === ACTION_DENIAL_REASON.CANDIDATE_BLACKLISTED)
      await this.blacklistFilter.evaluate(primary);

    this.logger.log(
      `[Bull][已暂停托管] 任务 ${jobId} 丢弃 ${messages.length} 条消息 (chatId=${chatId}, reason=${hit.reason})`,
    );

    await Promise.all(
      messages.map((message) =>
        this.deduplicationService
          .markMessageAsProcessedAsync(message.messageId)
          .catch((error: unknown) => {
            const errorMessage = toErrorMessage(error);
            this.logger.warn(
              `[Bull][已暂停托管] 去重标记失败 [${message.messageId}]: ${errorMessage}`,
            );
            return false;
          }),
      ),
    );

    await this.chatSession
      .markHistoryOnly(
        messages.map((message) => message.messageId),
        hit.reason === ACTION_DENIAL_REASON.CANDIDATE_BLACKLISTED
          ? FilterReason.CANDIDATE_BLACKLISTED
          : hit.reason === ACTION_DENIAL_REASON.GROUP_BLACKLISTED
            ? FilterReason.GROUP_BLACKLISTED
            : hit.reason === ACTION_DENIAL_REASON.HOSTING_PAUSED
              ? FilterReason.USER_PAUSED
              : FilterReason.ACTION_NOT_PERMITTED,
      )
      .catch((error: unknown) => {
        this.logger.warn(`[Bull][已暂停托管] 补记只存历史原因失败: ${toErrorMessage(error)}`);
        return 0;
      });

    await this.messageTracking
      .dropMergedSourceRecords(
        messages.map((message) => message.messageId),
        String(jobId),
      )
      .catch((error: unknown) => {
        this.logger.warn(`[Bull][已暂停托管] 回收 processing 流水失败: ${toErrorMessage(error)}`);
      });
    return true;
  }

  // ==================== 公共 API ====================

  setConcurrency(newConcurrency: number) {
    return this.workerManager.setConcurrency(newConcurrency);
  }

  getWorkerStatus() {
    return this.workerManager.getStatus();
  }

  async getQueueStatus(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
    delayed: number;
    paused: number;
  }> {
    const [waiting, active, completed, failed, delayed, paused] = await Promise.all([
      this.messageQueue.getWaitingCount(),
      this.messageQueue.getActiveCount(),
      this.messageQueue.getCompletedCount(),
      this.messageQueue.getFailedCount(),
      this.messageQueue.getDelayedCount(),
      this.messageQueue.getPausedCount(),
    ]);

    return { waiting, active, completed, failed, delayed, paused };
  }

  async cleanStuckJobs(options?: {
    cleanActive?: boolean;
    cleanFailed?: boolean;
    gracePeriodMs?: number;
  }): Promise<{
    success: boolean;
    cleaned: { active: number; failed: number };
    message: string;
  }> {
    const { cleanActive = true, cleanFailed = true, gracePeriodMs = 0 } = options || {};
    const cleaned = { active: 0, failed: 0 };

    try {
      if (cleanActive) {
        const activeJobs = await this.messageQueue.getActive();
        for (const job of activeJobs) {
          const jobAge = Date.now() - job.timestamp;
          if (jobAge >= gracePeriodMs) {
            await job.moveToFailed(new Error('手动清理：任务卡住'), true);
            await job.remove();
            cleaned.active++;
          }
        }
      }

      if (cleanFailed) {
        const failedJobs = await this.messageQueue.getFailed();
        for (const job of failedJobs) {
          await job.remove();
          cleaned.failed++;
        }
      }

      const totalCleaned = cleaned.active + cleaned.failed;

      return {
        success: true,
        cleaned,
        message: totalCleaned > 0 ? `已清理 ${totalCleaned} 个任务` : '没有需要清理的任务',
      };
    } catch (error) {
      const errorMessage = toErrorMessage(error);
      return {
        success: false,
        cleaned,
        message: `清理失败: ${errorMessage}`,
      };
    }
  }
}
