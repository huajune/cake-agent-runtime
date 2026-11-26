import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { MESSAGE_WORKER_CONCURRENCY } from '@biz/hosting-config/types/hosting-config.types';
import { toErrorMessage } from '@infra/utils/error.util';
import type { MessageJob, MessageWorkerConsumer } from './message-worker-consumer';

@Injectable()
export class MessageWorkerManagerService {
  private readonly logger = new Logger(MessageWorkerManagerService.name);
  private target: number = MESSAGE_WORKER_CONCURRENCY.default;
  private registered = 0;
  private activeJobs = 0;
  private createWorker?: (concurrency: number) => MessageWorkerConsumer;
  private processJob?: (job: MessageJob) => Promise<void>;
  private worker?: MessageWorkerConsumer;
  private replacing?: Promise<void>;
  private configWork = Promise.resolve();
  private refreshing = false;
  private stopping = false;

  constructor(private readonly systemConfigService: SystemConfigService) {}

  async initialize(
    createWorker: (concurrency: number) => MessageWorkerConsumer,
    processJob: (job: MessageJob) => Promise<void>,
  ) {
    this.createWorker = createWorker;
    this.processJob = processJob;
    await this.refreshConcurrency();
    await this.replacing;
  }

  // 配置是跨实例共享的。只在后台定期对账，消息处理路径不查配置表。
  @Interval(30_000)
  async refreshConcurrency(): Promise<void> {
    if (!this.createWorker || this.stopping || this.refreshing) return;
    this.refreshing = true;
    try {
      await this.serializeConfig(async () => {
        const config = await this.systemConfigService.getSystemConfig();
        const { min, max, default: fallback } = MESSAGE_WORKER_CONCURRENCY;
        this.target = Number.isInteger(config?.workerConcurrency)
          ? Math.max(min, Math.min(max, config.workerConcurrency))
          : fallback;
      });
    } catch (error) {
      this.logger.warn(`读取 Worker 并发配置失败: ${toErrorMessage(error)}`);
    } finally {
      this.refreshing = false;
      this.reconcile();
    }
  }

  setConcurrency(value: number) {
    return this.serializeConfig(async () => {
      const previousConcurrency = this.target;
      const result = (success: boolean, message: string) => ({
        success,
        message,
        previousConcurrency,
        currentConcurrency: this.target,
        registeredConcurrency: this.registered,
      });
      const { min, max } = MESSAGE_WORKER_CONCURRENCY;
      if (!Number.isInteger(value) || value < min || value > max) {
        return result(false, `并发数必须是 ${min} 至 ${max} 的整数`);
      }
      if (!this.createWorker || this.stopping) return result(false, 'Worker 尚未就绪或正在关闭');
      try {
        // 即使本机目标相同，也要以这次已确认的持久化写入为准。
        await this.systemConfigService.updateSystemConfig({ workerConcurrency: value });
      } catch (error) {
        return result(false, `保存并发配置失败: ${toErrorMessage(error)}`);
      }
      this.target = value;
      this.reconcile();
      return result(
        true,
        this.registered === value ? `当前已注册 ${value} 个槽` : `已保存 ${value}，正在切换 Worker`,
      );
    });
  }

  async getStatus() {
    const messageMergeEnabled = await this.systemConfigService.getMessageMergeEnabled();
    return {
      concurrency: this.target,
      registeredConcurrency: this.registered,
      activeJobs: this.activeJobs,
      minConcurrency: MESSAGE_WORKER_CONCURRENCY.min,
      maxConcurrency: MESSAGE_WORKER_CONCURRENCY.max,
      messageMergeEnabled,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.registered = 0;
    // 切换中的旧组已在排空，准备中的新组看到 stopping 后退出。
    if (this.replacing) await this.replacing;
    await this.worker?.close();
  }

  private serializeConfig<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.configWork.then(operation);
    this.configWork = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private reconcile(): void {
    if (this.stopping || this.replacing || this.registered === this.target) return;
    this.replacing = this.replaceWorker()
      .catch((error) =>
        this.logger.error(`切换 Bull Worker 失败，将重试: ${toErrorMessage(error)}`),
      )
      .finally(() => {
        this.replacing = undefined;
        if (this.registered && this.registered !== this.target) this.reconcile();
      });
  }

  private async replaceWorker(): Promise<void> {
    // Bull 4 的命名处理器只能注册一次。只排空本实例的消费者，生产者仍可向同一队列入队。
    this.registered = 0;
    while (!this.stopping) {
      if (this.worker) {
        try {
          await this.worker.close();
        } finally {
          this.worker = undefined;
        }
      }
      if (this.stopping) return;
      const concurrency = this.target;
      const worker = this.createWorker(concurrency);
      this.worker = worker;
      let timer: NodeJS.Timeout;
      try {
        await Promise.race([
          worker.ready(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error('等待 Bull Redis 连接超过 30 秒')), 30_000);
          }),
        ]);
        if (this.stopping) return;
        // 连接准备期间再次调整时，直接注册最新配置，避免领取过期档位的新任务。
        if (this.target !== concurrency) continue;
        this.register(worker, concurrency);
        return;
      } catch (error) {
        await worker.close();
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  private register(worker: MessageWorkerConsumer, concurrency: number): void {
    const running = worker.process(async (job: MessageJob) => {
      this.activeJobs++;
      try {
        await this.processJob(job);
      } finally {
        this.activeJobs--;
      }
    });
    this.registered = concurrency;
    this.logger.log(`[Bull] message-merge 已注册并发 ${concurrency}`);
    // process() 在消费循环退出时才 settle，不能在注册处 await。
    void running.catch((error) => {
      if (this.worker !== worker || this.stopping) return;
      this.registered = 0;
      this.logger.error(`Bull 消费循环退出，将重试: ${toErrorMessage(error)}`);
      void worker.close().catch((closeError) => this.logger.error(toErrorMessage(closeError)));
    });
  }
}
