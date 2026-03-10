import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';

/**
 * 小时统计数据库记录格式
 */
interface HourlyStatsDbRecord {
  hour: string;
  message_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
  p50_duration: number;
  p95_duration: number;
  p99_duration: number;
  avg_ai_duration: number;
  avg_send_duration: number;
  active_users: number;
  active_chats: number;
  total_token_usage: number;
  fallback_count: number;
  fallback_success_count: number;
  scenario_stats: Record<string, { count: number; successCount: number; avgDuration: number }>;
  tool_stats: Record<string, number>;
}

/**
 * 小时统计应用层格式
 */
export interface HourlyStatsRecord {
  hour: string;
  messageCount: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDuration: number;
  minDuration: number;
  maxDuration: number;
  p50Duration: number;
  p95Duration: number;
  p99Duration: number;
  avgAiDuration: number;
  avgSendDuration: number;
  activeUsers: number;
  activeChats: number;
  totalTokenUsage: number;
  fallbackCount: number;
  fallbackSuccessCount: number;
  scenarioStats: Record<string, { count: number; successCount: number; avgDuration: number }>;
  toolStats: Record<string, number>;
}

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
