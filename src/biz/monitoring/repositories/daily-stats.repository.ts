import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@infra/supabase/base.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { formatLocalDate } from '@infra/utils/date.util';
import type { DailyStatsDbRecord, DailyStatsRecord } from '../types/repository.types';

/**
 * 监控日统计 Repository
 *
 * 负责管理 monitoring_daily_stats 表：
 * - UPSERT 日级聚合统计
 * - 按日期范围查询统计数据
 */
@Injectable()
export class MonitoringDailyStatsRepository extends BaseRepository {
  protected readonly tableName = 'monitoring_daily_stats';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  async saveDailyStats(stats: DailyStatsRecord): Promise<void> {
    await this.upsert(this.toDbRecord(stats), {
      onConflict: 'stat_date',
      returnData: false,
    });
  }

  async getLatestDailyStat(): Promise<DailyStatsRecord | null> {
    const result = await this.selectOne<DailyStatsDbRecord>('*', (q) =>
      q.order('stat_date', { ascending: false }),
    );

    return result ? this.fromDbRecord(result) : null;
  }

  async getDailyStatsByDateRange(startDate: Date, endDate: Date): Promise<DailyStatsRecord[]> {
    const start = formatLocalDate(startDate);
    const end = formatLocalDate(endDate);

    const results = await this.select<DailyStatsDbRecord>('*', (q) =>
      q.gte('stat_date', start).lt('stat_date', end).order('stat_date', { ascending: true }),
    );

    return results.map((row) => this.fromDbRecord(row));
  }

  async clearAllRecords(): Promise<void> {
    if (!this.isAvailable()) return;
    await this.delete((q) => q.gte('stat_date', '1970-01-01'));
    this.logger.warn('[日统计] 已清空所有数据库记录');
  }

  private toDbRecord(stats: DailyStatsRecord): DailyStatsDbRecord {
    return {
      stat_date: stats.date,
      message_count: stats.messageCount,
      success_count: stats.successCount,
      failure_count: stats.failureCount,
      timeout_count: stats.timeoutCount,
      success_rate: stats.successRate,
      avg_duration: stats.avgDuration,
      total_token_usage: stats.tokenUsage,
      unique_users: stats.uniqueUsers,
      unique_chats: stats.uniqueChats,
      fallback_count: stats.fallbackCount,
      fallback_success_count: stats.fallbackSuccessCount,
      fallback_affected_users: stats.fallbackAffectedUsers,
      avg_queue_duration: stats.avgQueueDuration,
      avg_prep_duration: stats.avgPrepDuration,
      error_type_stats: stats.errorTypeStats ?? {},
    };
  }

  private fromDbRecord(row: DailyStatsDbRecord): DailyStatsRecord {
    return {
      date: row.stat_date,
      messageCount: row.message_count,
      successCount: row.success_count,
      failureCount: row.failure_count,
      timeoutCount: row.timeout_count ?? 0,
      successRate: row.success_rate,
      avgDuration: row.avg_duration,
      tokenUsage: row.total_token_usage ?? 0,
      uniqueUsers: row.unique_users ?? 0,
      uniqueChats: row.unique_chats ?? 0,
      fallbackCount: row.fallback_count ?? 0,
      fallbackSuccessCount: row.fallback_success_count ?? 0,
      fallbackAffectedUsers: row.fallback_affected_users ?? 0,
      avgQueueDuration: row.avg_queue_duration ?? 0,
      avgPrepDuration: row.avg_prep_duration ?? 0,
      errorTypeStats: row.error_type_stats ?? {},
    };
  }
}
