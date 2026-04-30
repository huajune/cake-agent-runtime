import { Injectable, Logger } from '@nestjs/common';
import { MonitoringGlobalCounters } from '@shared-types/tracking.types';
import { RedisService } from '@infra/redis/redis.service';

/**
 * 监控缓存服务
 * - 全局累计计数器：进程内内存
 * - 实时请求数 / 峰值：Redis 共享计数，多实例一致
 */
@Injectable()
export class MonitoringCacheService {
  private readonly logger = new Logger(MonitoringCacheService.name);
  private readonly activeRequestsKey = 'monitoring:active_requests';
  private readonly peakActiveRequestsKey = 'monitoring:peak_active_requests';

  private counters: MonitoringGlobalCounters = {
    totalMessages: 0,
    totalSuccess: 0,
    totalFailure: 0,
    totalAiDuration: 0,
    totalSendDuration: 0,
    totalFallback: 0,
    totalFallbackSuccess: 0,
    totalOutputLeakSkipped: 0,
    totalHostingPausedSkipped: 0,
    totalSameBrandCollapseSkipped: 0,
    totalPayrollDeferSkipped: 0,
  };

  constructor(private readonly redisService: RedisService) {}

  // ========================================
  // 全局计数器
  // ========================================

  async incrementCounter(field: keyof MonitoringGlobalCounters, value: number = 1): Promise<void> {
    this.counters[field] += value;
  }

  async incrementCounters(updates: Partial<MonitoringGlobalCounters>): Promise<void> {
    for (const [field, value] of Object.entries(updates)) {
      if (typeof value === 'number') {
        this.counters[field as keyof MonitoringGlobalCounters] += value;
      }
    }
  }

  async getCounters(): Promise<MonitoringGlobalCounters> {
    return { ...this.counters };
  }

  async resetCounters(): Promise<void> {
    this.counters = {
      totalMessages: 0,
      totalSuccess: 0,
      totalFailure: 0,
      totalAiDuration: 0,
      totalSendDuration: 0,
      totalFallback: 0,
      totalFallbackSuccess: 0,
      totalOutputLeakSkipped: 0,
      totalHostingPausedSkipped: 0,
      totalSameBrandCollapseSkipped: 0,
      totalPayrollDeferSkipped: 0,
    };
    this.logger.log('全局计数器已重置');
  }

  async setCounters(counters: MonitoringGlobalCounters): Promise<void> {
    this.counters = { ...counters };
    this.logger.log('全局计数器已设置');
  }

  // ========================================
  // 实时请求统计（Redis 共享）
  // ========================================

  async setActiveRequests(count: number): Promise<void> {
    await this.redisService.set(this.activeRequestsKey, this.normalizeCount(count));
  }

  async getActiveRequests(): Promise<number> {
    return this.readCount(this.activeRequestsKey);
  }

  async incrementActiveRequests(delta: number = 1): Promise<number> {
    const nextCount = Number(await this.redisService.incrby(this.activeRequestsKey, delta));

    if (!Number.isFinite(nextCount) || nextCount < 0) {
      await this.setActiveRequests(0);
      return 0;
    }

    if (delta > 0) {
      await this.updatePeakActiveRequests(nextCount);
    }

    return nextCount;
  }

  async updatePeakActiveRequests(count: number): Promise<void> {
    const normalizedCount = this.normalizeCount(count);
    const currentPeak = await this.getPeakActiveRequests();

    if (normalizedCount > currentPeak) {
      await this.redisService.set(this.peakActiveRequestsKey, normalizedCount);
    }
  }

  async getPeakActiveRequests(): Promise<number> {
    return this.readCount(this.peakActiveRequestsKey);
  }

  async setPeakActiveRequests(count: number): Promise<void> {
    await this.redisService.set(this.peakActiveRequestsKey, this.normalizeCount(count));
  }

  // ========================================
  // 辅助方法
  // ========================================

  async clearAll(): Promise<void> {
    await this.resetCounters();
    await Promise.all([this.setActiveRequests(0), this.setPeakActiveRequests(0)]);
    this.logger.log('所有监控缓存数据已清空');
  }

  private async readCount(key: string): Promise<number> {
    const value = await this.redisService.get<number | string>(key);
    const parsed = typeof value === 'string' ? Number(value) : value;
    return this.normalizeCount(parsed);
  }

  private normalizeCount(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
  }
}
