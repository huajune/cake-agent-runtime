import { Injectable, Logger } from '@nestjs/common';
import { MonitoringGlobalCounters } from '@shared-types/tracking.types';

/**
 * 监控缓存服务
 * 使用进程内内存存储高频更新的实时指标（单实例部署）
 */
@Injectable()
export class MonitoringCacheService {
  private readonly logger = new Logger(MonitoringCacheService.name);

  private counters: MonitoringGlobalCounters = {
    totalMessages: 0,
    totalSuccess: 0,
    totalFailure: 0,
    totalAiDuration: 0,
    totalSendDuration: 0,
    totalFallback: 0,
    totalFallbackSuccess: 0,
  };

  private currentProcessing = 0;
  private peakProcessing = 0;

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
    };
    this.logger.log('全局计数器已重置');
  }

  async setCounters(counters: MonitoringGlobalCounters): Promise<void> {
    this.counters = { ...counters };
    this.logger.log('全局计数器已设置');
  }

  // ========================================
  // 实时并发统计
  // ========================================

  async setCurrentProcessing(count: number): Promise<void> {
    this.currentProcessing = count;
  }

  async getCurrentProcessing(): Promise<number> {
    return this.currentProcessing;
  }

  async incrementCurrentProcessing(delta: number = 1): Promise<number> {
    this.currentProcessing += delta;
    return this.currentProcessing;
  }

  async updatePeakProcessing(count: number): Promise<void> {
    if (count > this.peakProcessing) {
      this.peakProcessing = count;
    }
  }

  async getPeakProcessing(): Promise<number> {
    return this.peakProcessing;
  }

  async setPeakProcessing(count: number): Promise<void> {
    this.peakProcessing = count;
  }

  // ========================================
  // 辅助方法
  // ========================================

  async clearAll(): Promise<void> {
    await this.resetCounters();
    this.currentProcessing = 0;
    this.peakProcessing = 0;
    this.logger.log('所有监控缓存数据已清空');
  }
}
