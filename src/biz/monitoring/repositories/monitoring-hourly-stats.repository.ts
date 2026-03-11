import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import { HourlyStatsDbRecord } from '../types/repository.types';
import { HourlyStatsRecord } from '../types/repository.types';

/**
 * 监控小时统计 Repository
 *
 * 负责管理 monitoring_hourly_stats 表：
 * - UPSERT 小时级聚合统计
 * - 按时间范围查询统计数据
 */
@Injectable()
export class MonitoringHourlyStatsRepository extends BaseRepository {
  protected readonly tableName = 'monitoring_hourly_stats';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 保存小时级聚合统计（UPSERT）
   */
  async saveHourlyStats(stats: HourlyStatsRecord): Promise<void> {
    await this.upsert(this.toDbRecord(stats), {
      onConflict: 'hour',
      returnData: false,
    });
  }

  /**
   * 批量保存小时统计（UPSERT）
   */
  async saveHourlyStatsBatch(statsList: HourlyStatsRecord[]): Promise<void> {
    if (!statsList || statsList.length === 0) return;

    const records = statsList.map((s) => this.toDbRecord(s));
    await this.upsertBatch(records, { onConflict: 'hour' });
    this.logger.log(`批量保存 ${statsList.length} 条小时统计成功`);
  }

  /**
   * 查询最近 N 小时的统计数据
   */
  async getRecentHourlyStats(hours: number = 72): Promise<HourlyStatsRecord[]> {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);

    const results = await this.select<HourlyStatsDbRecord>('*', (q) =>
      q.gte('hour', cutoffTime.toISOString()).order('hour', { ascending: false }),
    );

    return results.map((r) => this.fromDbRecord(r));
  }

  /**
   * 按日期范围查询小时统计
   */
  async getHourlyStatsByDateRange(startDate: Date, endDate: Date): Promise<HourlyStatsRecord[]> {
    const results = await this.select<HourlyStatsDbRecord>('*', (q) =>
      q
        .gte('hour', startDate.toISOString())
        .lt('hour', endDate.toISOString())
        .order('hour', { ascending: true }),
    );

    return results.map((r) => this.fromDbRecord(r));
  }

  /**
   * 清空统计数据
   */
  async clearAllRecords(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.delete((q) => q.gte('hour', '1970-01-01'));
    this.logger.warn('[小时统计] 已清空所有数据库记录');
  }

  // ==================== 私有方法 ====================

  private toDbRecord(stats: HourlyStatsRecord): HourlyStatsDbRecord {
    return {
      hour: stats.hour,
      message_count: stats.messageCount,
      success_count: stats.successCount,
      failure_count: stats.failureCount,
      success_rate: stats.successRate,
      avg_duration: stats.avgDuration,
      min_duration: stats.minDuration,
      max_duration: stats.maxDuration,
      p50_duration: stats.p50Duration,
      p95_duration: stats.p95Duration,
      p99_duration: stats.p99Duration,
      avg_ai_duration: stats.avgAiDuration,
      avg_send_duration: stats.avgSendDuration,
      active_users: stats.activeUsers,
      active_chats: stats.activeChats,
      total_token_usage: stats.totalTokenUsage ?? 0,
      fallback_count: stats.fallbackCount ?? 0,
      fallback_success_count: stats.fallbackSuccessCount ?? 0,
      scenario_stats: stats.scenarioStats ?? {},
      tool_stats: stats.toolStats ?? {},
    };
  }

  private fromDbRecord(row: HourlyStatsDbRecord): HourlyStatsRecord {
    return {
      hour: row.hour,
      messageCount: row.message_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      successRate: row.success_rate,
      avgDuration: row.avg_duration,
      minDuration: row.min_duration,
      maxDuration: row.max_duration,
      p50Duration: row.p50_duration,
      p95Duration: row.p95_duration,
      p99Duration: row.p99_duration,
      avgAiDuration: row.avg_ai_duration,
      avgSendDuration: row.avg_send_duration,
      activeUsers: row.active_users,
      activeChats: row.active_chats,
      totalTokenUsage: row.total_token_usage ?? 0,
      fallbackCount: row.fallback_count ?? 0,
      fallbackSuccessCount: row.fallback_success_count ?? 0,
      scenarioStats: row.scenario_stats ?? {},
      toolStats: row.tool_stats ?? {},
    };
  }
}
