import { Injectable } from '@nestjs/common';
import { MonitoringDailyStatsRepository } from '../../repositories/daily-stats.repository';
import { DailyProjectionStats, DailyTrendData } from '../../types/analytics.types';

/**
 * 日统计聚合服务
 *
 * 从 monitoring_daily_stats 预聚合数据中重建按天展示的趋势数据。
 */
@Injectable()
export class DailyStatsAggregatorService {
  constructor(private readonly dailyStatsRepository: MonitoringDailyStatsRepository) {}

  async getDailyTrendFromDaily(startDate: Date, endDate: Date): Promise<DailyTrendData[]> {
    const rows = await this.dailyStatsRepository.getDailyStatsByDateRange(startDate, endDate);

    return rows.map((row) => ({
      date: row.date,
      messageCount: row.messageCount,
      successCount: row.successCount,
      avgDuration: row.avgDuration,
      tokenUsage: row.tokenUsage,
      uniqueUsers: row.uniqueUsers,
    }));
  }

  async getDailyProjectionStats(startDate: Date, endDate: Date): Promise<DailyProjectionStats[]> {
    return this.dailyStatsRepository.getDailyStatsByDateRange(startDate, endDate);
  }
}
