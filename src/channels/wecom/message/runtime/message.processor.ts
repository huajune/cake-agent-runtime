import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { ConfigService } from '@nestjs/config';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';

// 导入子服务
import { SimpleMergeService } from './simple-merge.service';
import { MessageDeduplicationService } from './deduplication.service';
import { MessagePipelineService } from '../application/pipeline.service';
import { MessageWorkerManagerService } from './message-worker-manager.service';

/**
 * 消息队列处理器（精简版 v2）
 *
 * 重构亮点：
 * - 直接依赖回复工作流编排，而非反向依赖入口服务
 * - 仅保留队列管理和任务调度逻辑
 * - 从 884 行精简到 ~200 行
 *
 * Job name: 'process'（由 SimpleMergeService 创建）
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
    private readonly userHostingService: UserHostingService,
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly configService: ConfigService,
  ) {
    this.drainTimeoutMs = parseInt(
      this.configService.get('SHUTDOWN_DRAIN_TIMEOUT_MS', '60000'),
      10,
    );
  }

  async onModuleInit() {
    await this.workerManager.initialize();
    this.setupQueueEventListeners();
    await this.waitForQueueReady();
    // 使用 currentConcurrency 注册，避免 Bull 拉起的 job 数超过 semaphore 容量后
    // 空转 job 占住 lockDuration（60s），阻塞后续 delayed job 的调度。
    this.registerWorkers(this.workerManager.getCurrentConcurrency());
    await this.waitForBclientReady();

    this.logger.log(
      `MessageProcessor 已初始化（简化版，并发数: ${this.workerManager.getCurrentConcurrency()}）`,
    );
  }

  /**
   * 发版/重启收到 SIGTERM 时优雅排空（需 main.ts 开启 enableShutdownHooks）。
   *
   * queue.close() 默认会先停止领取新任务，再等待 active 任务执行完成——让正在
   * 调 Agent / 投递中的消息走完整个流程（含 ack pending 与终态落库），而不是被
   * 半路杀死后永久卡在 processing（2026-06-09 v5.13.0 发版事故）。
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
        this.messageQueue.close().then(() => 'drained' as const),
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(`[Shutdown] 排空队列失败: ${errorMessage}`);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async waitForQueueReady(): Promise<void> {
    const maxWaitTime = 30000;
    const checkInterval = 100;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkClient = () => {
        const clientStatus = this.messageQueue.client?.status;

        if (clientStatus === 'ready') {
          this.logger.log('[Bull] ✅ Queue client 已就绪');
          resolve();
          return;
        }

        if (Date.now() - startTime > maxWaitTime) {
          this.logger.warn('[Bull] ⚠️ Queue client 连接超时，继续运行');
          resolve();
          return;
        }

        setTimeout(checkClient, checkInterval);
      };

      checkClient();
    });
  }

  private async waitForBclientReady(): Promise<void> {
    const queue = this.messageQueue as Queue & {
      bclient?: {
        status?: string;
      };
    };
    const maxWaitTime = 30000;
    const checkInterval = 100;
    const startTime = Date.now();

    return new Promise((resolve) => {
      const checkBclient = () => {
        const bclientStatus = queue.bclient?.status;

        if (bclientStatus === 'ready') {
          this.logger.log('[Bull] ✅ bclient 连接就绪');
          resolve();
          return;
        }

        if (Date.now() - startTime > maxWaitTime) {
          this.logger.warn('[Bull] ⚠️ bclient 连接超时，继续运行');
          resolve();
          return;
        }

        setTimeout(checkBclient, checkInterval);
      };

      checkBclient();
    });
  }

  private setupQueueEventListeners(): void {
    this.messageQueue.on('completed', (job: Job) => {
      this.logger.log(`[Bull] ✅ 任务 ${job.id} 完成`);
    });

    this.messageQueue.on('failed', (job: Job, error: Error) => {
      this.logger.error(`[Bull] ❌ 任务 ${job.id} 失败: ${error.message}`);
    });

    this.messageQueue.on('active', (job: Job) => {
      this.logger.log(`[Bull] 🔄 任务 ${job.id} 开始处理`);
    });

    this.messageQueue.on('stalled', (job: Job) => {
      this.logger.warn(`[Bull] ⚠️ 任务 ${job.id} 卡住（stalled）`);
    });
  }

  /**
   * 注册 Worker
   */
  private registerWorkers(concurrency: number): void {
    this.logger.log(`[Bull] 正在注册 Worker，并发数: ${concurrency}...`);

    // 注册 'process' (SimpleMergeService 创建的任务)
    this.messageQueue.process('process', concurrency, async (job: Job) => {
      return this.handleProcessJob(job);
    });

    this.logger.log(`[Bull] ✅ Worker 已注册`);
  }

  /**
   * 处理队列任务
   * 任务数据只包含 chatId，消息从 Redis 获取
   */
  private async handleProcessJob(job: Job<{ chatId: string }>) {
    const { chatId } = job.data;
    const lockOwner = `job:${job.id}:${Date.now()}`;
    let lockAcquired = false;

    try {
      await this.workerManager.acquireExecutionSlot();
      lockAcquired = await this.simpleMergeService.acquireProcessingLock(chatId, lockOwner);
      if (!lockAcquired) {
        this.logger.debug(`[Bull] chatId=${chatId} 已有任务在处理中，跳过当前任务 ${job.id}`);
        // 持锁进程可能已被发版重启杀死（孤悬锁最长存活到 TTL 过期），若只是静默
        // 跳过，pending 会跟着自身 TTL 过期、消息永久丢失。补建延迟重检任务并
        // 续期 pending，确保锁过期后仍有任务接手。
        await this.simpleMergeService.scheduleLockRetryCheck(chatId);
        return;
      }

      this.logger.log(`[Bull] 开始处理任务 ${job.id}, chatId: ${chatId}`);

      const quietWindowElapsed = await this.simpleMergeService.isQuietWindowElapsed(chatId);
      if (!quietWindowElapsed) {
        this.logger.debug(`[Bull] chatId=${chatId} 静默窗口未结束，跳过当前检查任务 ${job.id}`);
        return;
      }

      // 抓取 pending 快照但不清空。处理成功后 reply-workflow 会调用 ackPendingMessages
      // 把已消费的部分裁掉；agent 执行中进程被 kill → 跳过 ack → pending 保留 → Bull
      // stalled retry 拉起的新 worker 仍能拿到完整数据，避免候选人消息被吞。
      const { messages, snapshotSize, batchId } =
        await this.simpleMergeService.claimPendingSnapshot(chatId);

      if (messages.length === 0) {
        this.logger.debug(`[Bull] 任务 ${job.id} 没有待处理消息，跳过`);
        return;
      }

      // 入口 PausedUserFilterRule 在消息进入 debounce 静默窗口前已经过一次
      // isUserPaused，但运营在静默窗口内点关托管时，已入队的 batch 会绕过入口
      // 检查直接落到这里。worker 拉起后再复查一次：命中即丢弃整批，避免穿透
      // 到 Agent 投递（1tsdimfg badcase）。
      if (await this.dropIfHostingPaused(chatId, messages, job.id)) {
        // 命中暂停 → 已显式 markMessageAsProcessedAsync，pending 这部分也应当裁掉。
        await this.simpleMergeService.ackPendingMessages(chatId, snapshotSize);
        return;
      }

      // 处理消息
      await this.processMessages(messages, batchId, snapshotSize);

      // 处理完后若又收到了新消息，则按“最后一条消息后的静默窗口”补建下一轮检查任务
      await this.simpleMergeService.checkAndProcessNewMessages(chatId);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[Bull] 任务 ${job.id} 处理失败: ${errorMessage}`);
      throw error;
    } finally {
      if (lockAcquired) {
        await this.simpleMergeService.releaseProcessingLock(chatId, lockOwner).catch((error) => {
          const errorMessage = error instanceof Error ? error.message : String(error);
          this.logger.warn(`[Bull] 释放 chatId=${chatId} 处理锁失败: ${errorMessage}`);
        });
      }
      this.workerManager.releaseExecutionSlot();
    }
  }

  /**
   * 处理消息的核心逻辑
   * 直接委托给聚合消息工作流。`initialSnapshotSize` 透传给 reply-workflow，用于在
   * 投递成功后 ack 掉初次抓取的 N 条 pending（含 replay 阶段补抓的部分由 reply-workflow
   * 自行累加再一次 ack）。
   */
  private async processMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
    initialSnapshotSize: number,
  ): Promise<void> {
    await this.messagePipeline.processMergedMessages(messages, batchId, initialSnapshotSize);
  }

  /**
   * 静默窗口期内运营关托管 → drain 出来的 batch 命中暂停时直接丢弃。
   *
   * 同时把每条 messageId 标记为已处理（与 historyOnly 路径对齐），避免回调
   * 重试时再次进入 debounce 队列。
   */
  private async dropIfHostingPaused(
    chatId: string,
    messages: EnterpriseMessageCallbackDto[],
    jobId: string | number,
  ): Promise<boolean> {
    const primary = messages[messages.length - 1];
    const hit = await this.userHostingService.isAnyPaused([
      chatId,
      primary.imContactId,
      primary.externalUserId,
    ]);
    if (!hit.paused) return false;

    this.logger.log(
      `[Bull][已暂停托管] 任务 ${jobId} 丢弃 ${messages.length} 条消息 (chatId=${chatId}, matchedId=${hit.matchedId})`,
    );

    await Promise.all(
      messages.map((message) =>
        this.deduplicationService
          .markMessageAsProcessedAsync(message.messageId)
          .catch((error: unknown) => {
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `[Bull][已暂停托管] 去重标记失败 [${message.messageId}]: ${errorMessage}`,
            );
            return false;
          }),
      ),
    );
    return true;
  }

  // ==================== 公共 API ====================

  async setConcurrency(newConcurrency: number): Promise<{
    success: boolean;
    message: string;
    previousConcurrency: number;
    currentConcurrency: number;
  }> {
    return this.workerManager.setConcurrency(newConcurrency);
  }

  async getWorkerStatus(): Promise<{
    concurrency: number;
    activeJobs: number;
    minConcurrency: number;
    maxConcurrency: number;
    messageMergeEnabled: boolean;
  }> {
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
      const errorMessage = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        cleaned,
        message: `清理失败: ${errorMessage}`,
      };
    }
  }
}
