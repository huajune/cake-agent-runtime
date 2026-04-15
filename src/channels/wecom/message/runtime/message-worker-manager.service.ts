import { Injectable, Logger } from '@nestjs/common';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';

@Injectable()
export class MessageWorkerManagerService {
  private readonly logger = new Logger(MessageWorkerManagerService.name);
  private readonly minConcurrency = 1;
  private readonly maxConcurrency = 20;
  private readonly registrationConcurrency = this.maxConcurrency;
  private currentConcurrency = 4;
  private activeJobs = 0;
  private readonly pendingExecutionResolvers: Array<() => void> = [];

  constructor(private readonly systemConfigService: SystemConfigService) {}

  async initialize(): Promise<void> {
    try {
      const config = await this.systemConfigService.getSystemConfig();
      if (config?.workerConcurrency) {
        this.currentConcurrency = this.normalizeConcurrency(config.workerConcurrency);
        this.logger.log(`从配置加载 Worker 并发数: ${this.currentConcurrency}`);
      }
    } catch (error) {
      this.logger.warn(`加载并发数配置失败，使用默认值: ${error.message}`);
    }
  }

  getRegistrationConcurrency(): number {
    return this.registrationConcurrency;
  }

  getCurrentConcurrency(): number {
    return this.currentConcurrency;
  }

  async acquireExecutionSlot(): Promise<void> {
    if (this.activeJobs < this.currentConcurrency) {
      this.activeJobs++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.pendingExecutionResolvers.push(() => {
        this.activeJobs++;
        resolve();
      });
    });
  }

  releaseExecutionSlot(): void {
    this.activeJobs = Math.max(this.activeJobs - 1, 0);
    this.drainExecutionResolvers();
  }

  async setConcurrency(newConcurrency: number): Promise<{
    success: boolean;
    message: string;
    previousConcurrency: number;
    currentConcurrency: number;
  }> {
    const previousConcurrency = this.currentConcurrency;

    if (newConcurrency < this.minConcurrency || newConcurrency > this.maxConcurrency) {
      return {
        success: false,
        message: `并发数必须在 ${this.minConcurrency}-${this.maxConcurrency} 之间`,
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
      this.drainExecutionResolvers();

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

  async getStatus(): Promise<{
    concurrency: number;
    activeJobs: number;
    minConcurrency: number;
    maxConcurrency: number;
    messageMergeEnabled: boolean;
  }> {
    const messageMergeEnabled = await this.systemConfigService.getMessageMergeEnabled();

    return {
      concurrency: this.currentConcurrency,
      activeJobs: this.activeJobs,
      minConcurrency: this.minConcurrency,
      maxConcurrency: this.maxConcurrency,
      messageMergeEnabled,
    };
  }

  private drainExecutionResolvers(): void {
    while (this.activeJobs < this.currentConcurrency && this.pendingExecutionResolvers.length > 0) {
      const next = this.pendingExecutionResolvers.shift();
      next?.();
    }
  }

  private normalizeConcurrency(value: number): number {
    return Math.max(this.minConcurrency, Math.min(this.maxConcurrency, value));
  }
}
