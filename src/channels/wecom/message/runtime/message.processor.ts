import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';

// 导入子服务
import { SimpleMergeService } from './simple-merge.service';
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
export class MessageProcessor implements OnModuleInit {
  private readonly logger = new Logger(MessageProcessor.name);

  constructor(
    @InjectQueue('message-merge') private readonly messageQueue: Queue,
    private readonly messagePipeline: MessagePipelineService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly workerManager: MessageWorkerManagerService,
  ) {}

  async onModuleInit() {
    await this.workerManager.initialize();
    this.setupQueueEventListeners();
    await this.waitForQueueReady();
    this.registerWorkers(this.workerManager.getRegistrationConcurrency());
    await this.waitForBclientReady();

    this.logger.log(
      `MessageProcessor 已初始化（简化版，并发数: ${this.workerManager.getCurrentConcurrency()}）`,
    );
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
    const queue = this.messageQueue as any;
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
        return;
      }

      this.logger.log(`[Bull] 开始处理任务 ${job.id}, chatId: ${chatId}`);

      const quietWindowElapsed = await this.simpleMergeService.isQuietWindowElapsed(chatId);
      if (!quietWindowElapsed) {
        this.logger.debug(`[Bull] chatId=${chatId} 静默窗口未结束，跳过当前检查任务 ${job.id}`);
        return;
      }

      // 从 Redis 获取待处理消息
      const { messages, batchId } =
        await this.simpleMergeService.getAndClearPendingMessages(chatId);

      if (messages.length === 0) {
        this.logger.debug(`[Bull] 任务 ${job.id} 没有待处理消息，跳过`);
        return;
      }

      // 处理消息
      await this.processMessages(messages, batchId);

      // 处理完后若又收到了新消息，则按“最后一条消息后的静默窗口”补建下一轮检查任务
      await this.simpleMergeService.checkAndProcessNewMessages(chatId);
    } catch (error) {
      this.logger.error(`[Bull] 任务 ${job.id} 处理失败: ${error.message}`);
      throw error;
    } finally {
      if (lockAcquired) {
        await this.simpleMergeService.releaseProcessingLock(chatId, lockOwner).catch((error) => {
          this.logger.warn(`[Bull] 释放 chatId=${chatId} 处理锁失败: ${error.message}`);
        });
      }
      this.workerManager.releaseExecutionSlot();
    }
  }

  /**
   * 处理消息的核心逻辑
   * 直接委托给聚合消息工作流
   */
  private async processMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    await this.messagePipeline.processMergedMessages(messages, batchId);
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
      return {
        success: false,
        cleaned,
        message: `清理失败: ${error.message}`,
      };
    }
  }
}
