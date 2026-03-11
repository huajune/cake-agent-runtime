import { Injectable } from '@nestjs/common';
import { BaseRepository } from '@core/supabase';
import { SupabaseService } from '@core/supabase';
import {
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
  HourlyTrendData,
} from '../types';

// ==================== RPC 字段映射 ====================

const OVERVIEW_MAPPING = {
  totalMessages: { field: 'total_messages', type: 'int' as const },
  successCount: { field: 'success_count', type: 'int' as const },
  failureCount: { field: 'failure_count', type: 'int' as const },
  successRate: { field: 'success_rate', type: 'float' as const },
  avgDuration: { field: 'avg_duration', type: 'float' as const },
  activeUsers: { field: 'active_users', type: 'int' as const },
  activeChats: { field: 'active_chats', type: 'int' as const },
  totalTokenUsage: { field: 'total_token_usage', type: 'int' as const },
};

const FALLBACK_MAPPING = {
  totalCount: { field: 'fallback_total', type: 'int' as const },
  successCount: { field: 'fallback_success', type: 'int' as const },
  successRate: { field: 'fallback_success_rate', type: 'float' as const },
  affectedUsers: { field: 'fallback_affected_users', type: 'int' as const },
};

const TREND_MAPPING = {
  messageCount: { field: 'message_count', type: 'int' as const },
  successCount: { field: 'success_count', type: 'int' as const },
  avgDuration: { field: 'avg_duration', type: 'float' as const },
  tokenUsage: { field: 'token_usage', type: 'int' as const },
  uniqueUsers: { field: 'unique_users', type: 'int' as const },
};

const HOURLY_AGG_MAPPING = {
  messageCount: { field: 'message_count', type: 'int' as const },
  successCount: { field: 'success_count', type: 'int' as const },
  failureCount: { field: 'failure_count', type: 'int' as const },
  successRate: { field: 'success_rate', type: 'float' as const },
  avgDuration: { field: 'avg_duration', type: 'float' as const },
  minDuration: { field: 'min_duration', type: 'float' as const },
  maxDuration: { field: 'max_duration', type: 'float' as const },
  p50Duration: { field: 'p50_duration', type: 'float' as const },
  p95Duration: { field: 'p95_duration', type: 'float' as const },
  p99Duration: { field: 'p99_duration', type: 'float' as const },
  avgAiDuration: { field: 'avg_ai_duration', type: 'float' as const },
  avgSendDuration: { field: 'avg_send_duration', type: 'float' as const },
  activeUsers: { field: 'active_users', type: 'int' as const },
  activeChats: { field: 'active_chats', type: 'int' as const },
  totalTokenUsage: { field: 'total_token_usage', type: 'int' as const },
  fallbackCount: { field: 'fallback_count', type: 'int' as const },
  fallbackSuccessCount: { field: 'fallback_success_count', type: 'int' as const },
};

/**
 * 监控数据 Repository
 *
 * 负责 Dashboard 统计（通过 RPC 查询 message_processing_records）
 */
@Injectable()
export class MonitoringRepository extends BaseRepository {
  protected readonly tableName = 'message_processing_records';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  /**
   * 获取 Dashboard 概览统计
   */
  async getDashboardOverviewStats(startDate: Date, endDate: Date): Promise<DashboardOverviewStats> {
    const defaultResult: DashboardOverviewStats = {
      totalMessages: 0,
      successCount: 0,
      failureCount: 0,
      successRate: 0,
      avgDuration: 0,
      activeUsers: 0,
      activeChats: 0,
      totalTokenUsage: 0,
    };

    return this.rpcSingleRow('get_dashboard_overview_stats', defaultResult, OVERVIEW_MAPPING, {
      p_start_date: startDate.toISOString(),
      p_end_date: endDate.toISOString(),
    });
  }

  /**
   * 获取 Dashboard 降级统计
   */
  async getDashboardFallbackStats(startDate: Date, endDate: Date): Promise<DashboardFallbackStats> {
    const defaultResult: DashboardFallbackStats = {
      totalCount: 0,
      successCount: 0,
      successRate: 0,
      affectedUsers: 0,
    };

    return this.rpcSingleRow('get_dashboard_fallback_stats', defaultResult, FALLBACK_MAPPING, {
      p_start_date: startDate.toISOString(),
      p_end_date: endDate.toISOString(),
    });
  }

  /**
   * 获取 Dashboard 每日趋势
   */
  async getDashboardDailyTrend(startDate: Date, endDate: Date): Promise<DailyTrendData[]> {
    return this.rpcMappedList<DailyTrendData>(
      'get_dashboard_daily_trend',
      { ...TREND_MAPPING, date: { field: 'date', type: 'string' as const } },
      { p_start_date: startDate.toISOString(), p_end_date: endDate.toISOString() },
    );
  }

  /**
   * 获取 Dashboard 小时级趋势
   */
  async getDashboardHourlyTrend(startDate: Date, endDate: Date): Promise<HourlyTrendData[]> {
    return this.rpcMappedList<HourlyTrendData>(
      'get_dashboard_hourly_trend',
      { ...TREND_MAPPING, hour: { field: 'hour', type: 'string' as const } },
      { p_start_date: startDate.toISOString(), p_end_date: endDate.toISOString() },
    );
  }

  /**
   * 获取 Dashboard 分钟级趋势
   */
  async getDashboardMinuteTrend(
    startDate: Date,
    endDate: Date,
    intervalMinutes: number = 5,
  ): Promise<
    Array<{
      minute: string;
      messageCount: number;
      successCount: number;
      avgDuration: number;
      uniqueUsers: number;
    }>
  > {
    return this.rpcMappedList(
      'get_dashboard_minute_trend',
      {
        minute: { field: 'minute', type: 'string' as const },
        messageCount: { field: 'message_count', type: 'int' as const },
        successCount: { field: 'success_count', type: 'int' as const },
        avgDuration: { field: 'avg_duration', type: 'float' as const },
        uniqueUsers: { field: 'unique_users', type: 'int' as const },
      },
      {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
        p_interval_minutes: intervalMinutes,
      },
    );
  }

  /**
   * 获取 Dashboard 场景统计
   */
  async getDashboardScenarioStats(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      scenario: string;
      count: number;
      successCount: number;
      avgDuration: number;
    }>
  > {
    return this.rpcMappedList(
      'get_dashboard_scenario_stats',
      {
        scenario: { field: 'scenario', type: 'string' as const },
        count: { field: 'count', type: 'int' as const },
        successCount: { field: 'success_count', type: 'int' as const },
        avgDuration: { field: 'avg_duration', type: 'float' as const },
      },
      { p_start_date: startDate.toISOString(), p_end_date: endDate.toISOString() },
    );
  }

  /**
   * 获取 Dashboard 工具统计
   */
  async getDashboardToolStats(
    startDate: Date,
    endDate: Date,
  ): Promise<Array<{ toolName: string; useCount: number }>> {
    return this.rpcMappedList(
      'get_dashboard_tool_stats',
      {
        toolName: { field: 'tool_name', type: 'string' as const },
        useCount: { field: 'use_count', type: 'int' as const },
      },
      { p_start_date: startDate.toISOString(), p_end_date: endDate.toISOString() },
    );
  }

  // ==================== 小时聚合 RPC ====================

  /**
   * 调用数据库级聚合 RPC，替代 TypeScript 侧的聚合逻辑
   */
  async aggregateHourlyStats(
    hourStart: Date,
    hourEnd: Date,
  ): Promise<{
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
  } | null> {
    if (!this.isAvailable()) {
      return null;
    }

    try {
      const result = await this.rpc<Array<Record<string, unknown>>>('aggregate_hourly_stats', {
        p_hour_start: hourStart.toISOString(),
        p_hour_end: hourEnd.toISOString(),
      });

      if (!result || result.length === 0) {
        return null;
      }

      const row = result[0];
      const numericFields = this.mapRpcRow<{
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
      }>(row, HOURLY_AGG_MAPPING);

      return {
        ...numericFields,
        scenarioStats:
          (row.scenario_stats as Record<
            string,
            { count: number; successCount: number; avgDuration: number }
          >) ?? {},
        toolStats: (row.tool_stats as Record<string, number>) ?? {},
      };
    } catch (error) {
      this.logger.error('调用 aggregate_hourly_stats RPC 失败:', error);
      return null;
    }
  }

  // ==================== 私有辅助 ====================

  /**
   * 调用 RPC 并取第一行，转换字段，返回默认值 if 无数据
   */
  private async rpcSingleRow<T>(
    functionName: string,
    defaultResult: T,
    mapping: Record<string, { field: string; type: 'int' | 'float' | 'string' }>,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (!this.isAvailable()) {
      return defaultResult;
    }

    try {
      const result = await this.rpc<Array<Record<string, unknown>>>(functionName, params);

      if (!result || result.length === 0) {
        return defaultResult;
      }

      return this.mapRpcRow<T>(result[0], mapping);
    } catch (error) {
      this.logger.error(`获取 ${functionName} 失败:`, error);
      return defaultResult;
    }
  }

  /**
   * 调用 RPC 并转换每一行
   */
  private async rpcMappedList<T>(
    functionName: string,
    mapping: Record<string, { field: string; type: 'int' | 'float' | 'string' }>,
    params: Record<string, unknown>,
  ): Promise<T[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<Array<Record<string, unknown>>>(functionName, params);

      if (!result) {
        return [];
      }

      return result.map((row) => this.mapRpcRow<T>(row, mapping));
    } catch (error) {
      this.logger.error(`获取 ${functionName} 失败:`, error);
      return [];
    }
  }
}
