import { Injectable } from '@nestjs/common';
import { BaseRepository } from './base.repository';
import { SupabaseService } from '../supabase.service';

/**
 * Dashboard 概览统计
 */
export interface DashboardOverviewStats {
  totalMessages: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgDuration: number;
  activeUsers: number;
  activeChats: number;
  totalTokenUsage: number;
}

/**
 * Dashboard 降级统计
 */
export interface DashboardFallbackStats {
  totalCount: number;
  successCount: number;
  successRate: number;
  affectedUsers: number;
}

/**
 * 每日趋势数据
 */
export interface DailyTrendData {
  date: string;
  messageCount: number;
  successCount: number;
  avgDuration: number;
  tokenUsage: number;
  uniqueUsers: number;
}

/**
 * 小时趋势数据
 */
export interface HourlyTrendData {
  hour: string;
  messageCount: number;
  successCount: number;
  avgDuration: number;
  tokenUsage: number;
  uniqueUsers: number;
}

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

    if (!this.isAvailable()) {
      return defaultResult;
    }

    try {
      const result = await this.rpc<
        Array<{
          total_messages: string;
          success_count: string;
          failure_count: string;
          success_rate: string;
          avg_duration: string;
          active_users: string;
          active_chats: string;
          total_token_usage: string;
        }>
      >('get_dashboard_overview_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result || result.length === 0) {
        return defaultResult;
      }

      const stats = result[0];
      return {
        totalMessages: parseInt(stats.total_messages ?? '0', 10),
        successCount: parseInt(stats.success_count ?? '0', 10),
        failureCount: parseInt(stats.failure_count ?? '0', 10),
        successRate: parseFloat(stats.success_rate ?? '0'),
        avgDuration: parseFloat(stats.avg_duration ?? '0'),
        activeUsers: parseInt(stats.active_users ?? '0', 10),
        activeChats: parseInt(stats.active_chats ?? '0', 10),
        totalTokenUsage: parseInt(stats.total_token_usage ?? '0', 10),
      };
    } catch (error) {
      this.logger.error('获取 Dashboard 概览统计失败:', error);
      return defaultResult;
    }
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

    if (!this.isAvailable()) {
      return defaultResult;
    }

    try {
      const result = await this.rpc<
        Array<{
          fallback_total: string;
          fallback_success: string;
          fallback_success_rate: string;
          fallback_affected_users: string;
        }>
      >('get_dashboard_fallback_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result || result.length === 0) {
        return defaultResult;
      }

      const stats = result[0];
      return {
        totalCount: parseInt(stats.fallback_total ?? '0', 10),
        successCount: parseInt(stats.fallback_success ?? '0', 10),
        successRate: parseFloat(stats.fallback_success_rate ?? '0'),
        affectedUsers: parseInt(stats.fallback_affected_users ?? '0', 10),
      };
    } catch (error) {
      this.logger.error('获取 Dashboard 降级统计失败:', error);
      return defaultResult;
    }
  }

  /**
   * 获取 Dashboard 每日趋势
   */
  async getDashboardDailyTrend(startDate: Date, endDate: Date): Promise<DailyTrendData[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          date: string;
          message_count: string;
          success_count: string;
          avg_duration: string;
          token_usage: string;
          unique_users: string;
        }>
      >('get_dashboard_daily_trend', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        date: item.date,
        messageCount: parseInt(item.message_count ?? '0', 10),
        successCount: parseInt(item.success_count ?? '0', 10),
        avgDuration: parseFloat(item.avg_duration ?? '0'),
        tokenUsage: parseInt(item.token_usage ?? '0', 10),
        uniqueUsers: parseInt(item.unique_users ?? '0', 10),
      }));
    } catch (error) {
      this.logger.error('获取 Dashboard 每日趋势失败:', error);
      return [];
    }
  }

  /**
   * 获取 Dashboard 小时级趋势
   */
  async getDashboardHourlyTrend(startDate: Date, endDate: Date): Promise<HourlyTrendData[]> {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          hour: string;
          message_count: string;
          success_count: string;
          avg_duration: string;
          token_usage: string;
          unique_users: string;
        }>
      >('get_dashboard_hourly_trend', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        hour: item.hour,
        messageCount: parseInt(item.message_count ?? '0', 10),
        successCount: parseInt(item.success_count ?? '0', 10),
        avgDuration: parseFloat(item.avg_duration ?? '0'),
        tokenUsage: parseInt(item.token_usage ?? '0', 10),
        uniqueUsers: parseInt(item.unique_users ?? '0', 10),
      }));
    } catch (error) {
      this.logger.error('获取 Dashboard 小时趋势失败:', error);
      return [];
    }
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
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          minute: string;
          message_count: string;
          success_count: string;
          avg_duration: string;
          unique_users: string;
        }>
      >('get_dashboard_minute_trend', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
        p_interval_minutes: intervalMinutes,
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        minute: item.minute,
        messageCount: parseInt(item.message_count ?? '0', 10),
        successCount: parseInt(item.success_count ?? '0', 10),
        avgDuration: parseFloat(item.avg_duration ?? '0'),
        uniqueUsers: parseInt(item.unique_users ?? '0', 10),
      }));
    } catch (error) {
      this.logger.error('获取 Dashboard 分钟趋势失败:', error);
      return [];
    }
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
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          scenario: string;
          count: string;
          success_count: string;
          avg_duration: string;
        }>
      >('get_dashboard_scenario_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        scenario: item.scenario ?? 'unknown',
        count: parseInt(item.count ?? '0', 10),
        successCount: parseInt(item.success_count ?? '0', 10),
        avgDuration: parseFloat(item.avg_duration ?? '0'),
      }));
    } catch (error) {
      this.logger.error('获取 Dashboard 场景统计失败:', error);
      return [];
    }
  }

  /**
   * 获取 Dashboard 工具统计
   */
  async getDashboardToolStats(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      toolName: string;
      useCount: number;
    }>
  > {
    if (!this.isAvailable()) {
      return [];
    }

    try {
      const result = await this.rpc<
        Array<{
          tool_name: string;
          use_count: string;
        }>
      >('get_dashboard_tool_stats', {
        p_start_date: startDate.toISOString(),
        p_end_date: endDate.toISOString(),
      });

      if (!result) {
        return [];
      }

      return result.map((item) => ({
        toolName: item.tool_name ?? 'unknown',
        useCount: parseInt(item.use_count ?? '0', 10),
      }));
    } catch (error) {
      this.logger.error('获取 Dashboard 工具统计失败:', error);
      return [];
    }
  }

  // ==================== 小时聚合 RPC ====================

  /**
   * 调用数据库级聚合 RPC，替代 TypeScript 侧的聚合逻辑
   * 解决 getRecordsByTimeRange limit 2000 的 bug
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
      const result = await this.rpc<
        Array<{
          message_count: string;
          success_count: string;
          failure_count: string;
          success_rate: string;
          avg_duration: string;
          min_duration: string;
          max_duration: string;
          p50_duration: string;
          p95_duration: string;
          p99_duration: string;
          avg_ai_duration: string;
          avg_send_duration: string;
          active_users: string;
          active_chats: string;
          total_token_usage: string;
          fallback_count: string;
          fallback_success_count: string;
          scenario_stats: Record<
            string,
            { count: number; successCount: number; avgDuration: number }
          >;
          tool_stats: Record<string, number>;
        }>
      >('aggregate_hourly_stats', {
        p_hour_start: hourStart.toISOString(),
        p_hour_end: hourEnd.toISOString(),
      });

      if (!result || result.length === 0) {
        return null;
      }

      const row = result[0];
      return {
        messageCount: parseInt(row.message_count ?? '0', 10),
        successCount: parseInt(row.success_count ?? '0', 10),
        failureCount: parseInt(row.failure_count ?? '0', 10),
        successRate: parseFloat(row.success_rate ?? '0'),
        avgDuration: parseFloat(row.avg_duration ?? '0'),
        minDuration: parseFloat(row.min_duration ?? '0'),
        maxDuration: parseFloat(row.max_duration ?? '0'),
        p50Duration: parseFloat(row.p50_duration ?? '0'),
        p95Duration: parseFloat(row.p95_duration ?? '0'),
        p99Duration: parseFloat(row.p99_duration ?? '0'),
        avgAiDuration: parseFloat(row.avg_ai_duration ?? '0'),
        avgSendDuration: parseFloat(row.avg_send_duration ?? '0'),
        activeUsers: parseInt(row.active_users ?? '0', 10),
        activeChats: parseInt(row.active_chats ?? '0', 10),
        totalTokenUsage: parseInt(row.total_token_usage ?? '0', 10),
        fallbackCount: parseInt(row.fallback_count ?? '0', 10),
        fallbackSuccessCount: parseInt(row.fallback_success_count ?? '0', 10),
        scenarioStats: row.scenario_stats ?? {},
        toolStats: row.tool_stats ?? {},
      };
    } catch (error) {
      this.logger.error('调用 aggregate_hourly_stats RPC 失败:', error);
      return null;
    }
  }
}
