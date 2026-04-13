import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { HourlyStats } from '../../types/analytics.types';
import { MonitoringCacheService } from '../tracking/monitoring-cache.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringHourlyStatsRepository } from '../../repositories/hourly-stats.repository';
import { MonitoringErrorLogRepository } from '../../repositories/error-log.repository';
import { MonitoringRecordRepository } from '../../repositories/record.repository';
import { AlertLevel } from '@enums/alert.enum';
import { IncidentReporterService } from '@observability/incidents/incident-reporter.service';

/**
 * 数据清理与聚合维护服务
 * 负责清空历史数据、缓存清除以及每小时统计聚合定时任务
 */
@Injectable()
export class AnalyticsMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger(AnalyticsMaintenanceService.name);
  private readonly HOUR_MS = 60 * 60 * 1000;
  /** cron 触发：最多回填 14 天；startup 触发：只补最近 3 小时 */
  private readonly MAX_BACKFILL_HOURS_CRON = 24 * 14;
  private readonly MAX_BACKFILL_HOURS_STARTUP = 3;

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly cacheService: MonitoringCacheService,
    private readonly monitoringRepository: MonitoringRecordRepository,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {}

  onModuleInit(): void {
    // 启动后异步补齐缺失小时，避免因单次漏跑导致投影长期断更。
    void this.catchUpHourlyStats('startup');
  }

  // ========================================
  // 系统管理接口
  // ========================================

  /**
   * 清空所有监控统计数据（数据库记录）
   */
  async clearAllDataAsync(): Promise<void> {
    try {
      this.logger.warn('执行大规模数据清理: Monitoring stats & Message processing records');
      await Promise.all([
        this.messageProcessingService.clearAllRecords(),
        this.hourlyStatsRepository.clearAllRecords(),
        this.errorLogRepository.clearAllRecords(),
      ]);
      await this.cacheService.resetCounters();
    } catch (error) {
      this.logger.error('清空监控数据失败:', error);
      throw error;
    }
  }

  /**
   * 清除指定类型的缓存
   */
  async clearCacheAsync(type: 'all' | 'metrics' | 'history' | 'agent' = 'all'): Promise<void> {
    try {
      this.logger.log(`执行清除缓存任务: ${type}`);
      if (type === 'all' || type === 'metrics') {
        await this.cacheService.resetCounters();
      }

      if (type === 'all' || type === 'history') {
        await this.cacheService.clearAll();
      }

      if (type === 'all' || type === 'agent') {
        this.logger.log('Agent 缓存已由各独立模块自行管理');
      }
    } catch (error) {
      this.logger.error(`清除缓存失败 [${type}]:`, error);
      throw error;
    }
  }

  // ========================================
  // 定时聚合任务
  // ========================================

  /**
   * 小时统计聚合定时任务
   * 每小时第 5 分钟执行
   */
  @Cron('5 * * * *', {
    name: 'aggregateHourlyStats',
    timeZone: 'Asia/Shanghai',
  })
  async aggregateHourlyStats(): Promise<void> {
    await this.catchUpHourlyStats('cron');
  }

  private async catchUpHourlyStats(trigger: 'startup' | 'cron'): Promise<void> {
    try {
      const startTime = Date.now();
      this.logger.log(`开始执行小时统计聚合任务... trigger=${trigger}`);

      const now = new Date();
      const latestStored = await this.hourlyStatsRepository.getRecentHourlyStats(1);
      const maxHours =
        trigger === 'startup' ? this.MAX_BACKFILL_HOURS_STARTUP : this.MAX_BACKFILL_HOURS_CRON;
      const window = this.resolveBackfillWindow(now, latestStored[0]?.hour, maxHours);

      if (!window) {
        this.logger.debug(`[小时聚合] 无需补齐，投影已是最新状态 trigger=${trigger}`);
        return;
      }

      let processedHours = 0;
      let savedHours = 0;
      let emptyHours = 0;

      for (
        let hourStart = new Date(window.firstHourStart);
        hourStart.getTime() <= window.lastHourStart.getTime();
        hourStart = new Date(hourStart.getTime() + this.HOUR_MS)
      ) {
        processedHours += 1;
        const hourEnd = new Date(hourStart.getTime() + this.HOUR_MS);
        const saved = await this.aggregateSingleHour(hourStart, hourEnd);

        if (saved) {
          savedHours += 1;
        } else {
          emptyHours += 1;
        }
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `小时统计聚合完成: trigger=${trigger}, ` +
          `范围=${window.firstHourStart.toISOString()} ~ ${window.lastHourStart.toISOString()}, ` +
          `处理=${processedHours}h, 写入=${savedHours}h, 空窗=${emptyHours}h, 耗时=${elapsed}ms`,
      );
    } catch (error) {
      this.logger.error('小时统计聚合任务失败:', error);
      this.exceptionNotifier?.notifyAsync({
        source: {
          subsystem: 'monitoring',
          component: 'AnalyticsMaintenanceService',
          action: 'aggregateHourlyStats',
          trigger,
        },
        code: 'cron.job_failed',
        summary: '小时统计聚合任务失败',
        error,
        severity: AlertLevel.ERROR,
      });
    }
  }

  private async aggregateSingleHour(hourStart: Date, hourEnd: Date): Promise<boolean> {
    const hourKey = hourStart.toISOString();
    this.logger.verbose(`聚合时间范围: ${hourKey} ~ ${hourEnd.toISOString()}`);

    const aggregated = await this.monitoringRepository.aggregateHourlyStats(hourStart, hourEnd);

    if (!aggregated) {
      throw new Error(`aggregate_hourly_stats returned null for hour ${hourKey}`);
    }

    if (aggregated.messageCount === 0) {
      return false;
    }

    const hourlyStats: HourlyStats = {
      hour: hourKey,
      messageCount: aggregated.messageCount,
      successCount: aggregated.successCount,
      failureCount: aggregated.failureCount,
      successRate: aggregated.successRate,
      avgDuration: aggregated.avgDuration,
      minDuration: aggregated.minDuration,
      maxDuration: aggregated.maxDuration,
      p50Duration: aggregated.p50Duration,
      p95Duration: aggregated.p95Duration,
      p99Duration: aggregated.p99Duration,
      avgAiDuration: aggregated.avgAiDuration,
      avgSendDuration: aggregated.avgSendDuration,
      activeUsers: aggregated.activeUsers,
      activeChats: aggregated.activeChats,
      totalTokenUsage: aggregated.totalTokenUsage,
      fallbackCount: aggregated.fallbackCount,
      fallbackSuccessCount: aggregated.fallbackSuccessCount,
      scenarioStats: aggregated.scenarioStats,
      toolStats: aggregated.toolStats,
    };

    await this.hourlyStatsRepository.saveHourlyStats(hourlyStats);
    return true;
  }

  private resolveBackfillWindow(
    now: Date,
    latestStoredHour?: string,
    maxHours: number = this.MAX_BACKFILL_HOURS_CRON,
  ): { firstHourStart: Date; lastHourStart: Date } | null {
    const currentHourStart = this.getHourStart(now);
    const lastHourStart = new Date(currentHourStart.getTime() - this.HOUR_MS);

    let firstHourStart = latestStoredHour
      ? new Date(new Date(latestStoredHour).getTime() + this.HOUR_MS)
      : new Date(lastHourStart.getTime() - (maxHours - 1) * this.HOUR_MS);

    const earliestAllowedHour = new Date(
      lastHourStart.getTime() - (maxHours - 1) * this.HOUR_MS,
    );

    if (firstHourStart.getTime() < earliestAllowedHour.getTime()) {
      this.logger.warn(
        `[小时聚合] 回填窗口裁剪为最近 ${maxHours} 小时`,
      );
      firstHourStart = earliestAllowedHour;
    }

    if (firstHourStart.getTime() > lastHourStart.getTime()) {
      return null;
    }

    return { firstHourStart, lastHourStart };
  }

  private getHourStart(date: Date): Date {
    const hourStart = new Date(date);
    hourStart.setMinutes(0, 0, 0);
    return hourStart;
  }
}
