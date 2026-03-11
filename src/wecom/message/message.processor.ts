import { Injectable, Logger, OnModuleInit, forwardRef, Inject } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { Queue, Job } from 'bull';
import { EnterpriseMessageCallbackDto } from './dto/message-callback.dto';
import { SystemConfigService } from '@biz/hosting-config';
import { MonitoringService } from '@core/monitoring/monitoring.service';

// 导入子服务
import { SimpleMergeService } from './services/simple-merge.service';
import { MessageService } from './message.service';

/**
 * 消息队列处理器（精简版 v2）
 *
 * 重构亮点：
 * - 复用 MessageService.processMergedMessages，消除代码重复
 * - 仅保留队列管理和任务调度逻辑
 * - 从 884 行精简到 ~200 行
 *
 * Job name: 'process'（由 SimpleMergeService 创建）
 */
@Injectable()
export class MessageProcessor implements OnModuleInit {
  private readonly logger = new Logger(MessageProcessor.name);

  // Worker 状态
  private currentConcurrency = 4;
  private activeJobs = 0;

  // 并发数限制
  private readonly MIN_CONCURRENCY = 1;
  private readonly MAX_CONCURRENCY = 20;

  constructor(
    @InjectQueue('message-merge') private readonly messageQueue: Queue,
    @Inject(forwardRef(() => MessageService))
    private readonly messageService: MessageService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly systemConfigService: SystemConfigService,
    private readonly monitoringService: MonitoringService,
  ) {}

  async onModuleInit() {
    await this.loadConcurrencyFromConfig();
    this.setupQueueEventListeners();
    await this.waitForQueueReady();
    this.registerWorkers(this.currentConcurrency);
    await this.waitForBclientReady();

    this.logger.log(`MessageProcessor 已初始化（简化版，并发数: ${this.currentConcurrency}）`);
  }

  private async waitForQueueReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.messageQueue.client?.status === 'ready') {
        this.logger.log('Bull Queue 已就绪');
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('等待 Bull Queue 就绪超时'));
      }, 30000);

      this.messageQueue.on('ready', () => {
        clearTimeout(timeout);
        this.logger.log('Bull Queue 已就绪');
        resolve();
      });

      this.messageQueue.on('error', (error) => {
        clearTimeout(timeout);
        this.logger.error('Bull Queue 连接错误:', error);
        reject(error);
      });
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

  private async loadConcurrencyFromConfig(): Promise<void> {
    try {
      const config = await this.systemConfigService.getSystemConfig();
      if (config?.workerConcurrency) {
        this.currentConcurrency = Math.max(
          this.MIN_CONCURRENCY,
          Math.min(this.MAX_CONCURRENCY, config.workerConcurrency),
        );
        this.logger.log(`从配置加载 Worker 并发数: ${this.currentConcurrency}`);
      }
    } catch (error) {
      this.logger.warn(`加载并发数配置失败，使用默认值: ${error.message}`);
    }
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
    this.activeJobs++;
    const { chatId } = job.data;

    try {
      this.logger.log(`[Bull] 开始处理任务 ${job.id}, chatId: ${chatId}`);

      // 从 Redis 获取待处理消息
      const { messages, batchId } =
        await this.simpleMergeService.getAndClearPendingMessages(chatId);

      if (messages.length === 0) {
        this.logger.debug(`[Bull] 任务 ${job.id} 没有待处理消息，跳过`);
        return;
      }

      // 处理消息
      await this.processMessages(chatId, messages, batchId);

      // 处理完后检查是否有新消息
      await this.simpleMergeService.checkAndProcessNewMessages(chatId);
    } catch (error) {
      this.logger.error(`[Bull] 任务 ${job.id} 处理失败: ${error.message}`);
      throw error;
    } finally {
      this.activeJobs--;
    }
  }

  /**
   * 处理消息的核心逻辑
   * 复用 MessageService.processMergedMessages，消除代码重复
   */
  private async processMessages(
    chatId: string,
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    // 记录 Worker 开始处理时间
    for (const msg of messages) {
      this.monitoringService.recordWorkerStart(msg.messageId);
    }

    // 委托给 MessageService 处理（包含过滤、历史、Agent 调用、发送、去重标记）
    await this.messageService.processMergedMessages(messages, batchId);
  }

  // ==================== 公共 API ====================

  async setConcurrency(newConcurrency: number): Promise<{
    success: boolean;
    message: string;
    previousConcurrency: number;
    currentConcurrency: number;
  }> {
    const previousConcurrency = this.currentConcurrency;

    if (newConcurrency < this.MIN_CONCURRENCY || newConcurrency > this.MAX_CONCURRENCY) {
      return {
        success: false,
        message: `并发数必须在 ${this.MIN_CONCURRENCY}-${this.MAX_CONCURRENCY} 之间`,
        previousConcurrency,
        currentConcurrency: this.currentConcurrency,
      };
    }

    if (newConcurrency === this.currentConcurrency) {
      return {
        success: true,
        message: '并发数未变化',
        previousConcurrency,
        currentConcurrency: this.currentConcurrency,
      };
    }

    try {
      this.currentConcurrency = newConcurrency;
      await this.systemConfigService.updateSystemConfig({ workerConcurrency: newConcurrency });

      return {
        success: true,
        message: `并发数已从 ${previousConcurrency} 修改为 ${newConcurrency}`,
        previousConcurrency,
        currentConcurrency: newConcurrency,
      };
    } catch (error) {
      return {
        success: false,
        message: `修改失败: ${error.message}`,
        previousConcurrency,
        currentConcurrency: this.currentConcurrency,
      };
    }
  }

  getWorkerStatus(): {
    concurrency: number;
    activeJobs: number;
    minConcurrency: number;
    maxConcurrency: number;
  } {
    return {
      concurrency: this.currentConcurrency,
      activeJobs: this.activeJobs,
      minConcurrency: this.MIN_CONCURRENCY,
      maxConcurrency: this.MAX_CONCURRENCY,
    };
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
