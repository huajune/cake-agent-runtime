import { Injectable, Logger, Optional } from '@nestjs/common';
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
export class AnalyticsMaintenanceService {
  private readonly logger = new Logger(AnalyticsMaintenanceService.name);

  constructor(
    private readonly messageProcessingService: MessageProcessingService,
    private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository,
    private readonly errorLogRepository: MonitoringErrorLogRepository,
    private readonly cacheService: MonitoringCacheService,
    private readonly monitoringRepository: MonitoringRecordRepository,
    @Optional()
    private readonly exceptionNotifier?: IncidentReporterService,
  ) {}

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
    try {
      const startTime = Date.now();
      this.logger.log('开始执行小时统计聚合任务...');

      const now = new Date();
      const lastHourEnd = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
        now.getHours(),
        0,
        0,
        0,
      );
      const lastHourStart = new Date(lastHourEnd.getTime() - 60 * 60 * 1000);
      const hourKey = lastHourStart.toISOString();

      this.logger.log(
        `聚合时间范围: ${lastHourStart.toISOString()} ~ ${lastHourEnd.toISOString()}`,
      );

      const aggregated = await this.monitoringRepository.aggregateHourlyStats(
        lastHourStart,
        lastHourEnd,
      );

      if (!aggregated || aggregated.messageCount === 0) {
        this.logger.warn(`该小时无数据记录,跳过聚合: ${hourKey}`);
        return;
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

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `小时统计聚合完成: ${hourKey}, ` +
          `消息数=${aggregated.messageCount}, 成功率=${aggregated.successRate}%, ` +
          `活跃用户=${aggregated.activeUsers}, 活跃会话=${aggregated.activeChats}, ` +
          `Token=${aggregated.totalTokenUsage}, 耗时=${elapsed}ms`,
      );
    } catch (error) {
      this.logger.error('小时统计聚合任务失败:', error);
      this.exceptionNotifier?.notifyAsync({
        source: 'cron:aggregate-hourly-stats',
        errorType: 'cron_job_failed',
        title: '小时统计聚合任务失败',
        error,
        level: AlertLevel.ERROR,
      });
    }
  }
}
