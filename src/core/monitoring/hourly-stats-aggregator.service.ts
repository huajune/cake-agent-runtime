import { Injectable, Logger } from '@nestjs/common';
import {
  MonitoringHourlyStatsRepository,
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
  HourlyTrendData,
} from '@supabase/monitoring';
import { HourlyStats } from './interfaces/monitoring.interface';

/**
 * 小时统计聚合服务
 *
 * 从 monitoring_hourly_stats 预聚合数据中重建 Dashboard 所需的各类统计。
 * 用于非实时查询（昨天/本周/本月），替代直接扫描 message_processing_records。
 */
@Injectable()
export class HourlyStatsAggregatorService {
  private readonly logger = new Logger(HourlyStatsAggregatorService.name);

  constructor(private readonly hourlyStatsRepository: MonitoringHourlyStatsRepository) {}

  /**
   * 从小时统计聚合概览数据
   */
  async getOverviewFromHourly(startDate: Date, endDate: Date): Promise<DashboardOverviewStats> {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    if (rows.length === 0) {
      return {
        totalMessages: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        activeUsers: 0,
        activeChats: 0,
        totalTokenUsage: 0,
      };
    }

    const totalMessages = this.sumField(rows, 'messageCount');
    const successCount = this.sumField(rows, 'successCount');
    const failureCount = this.sumField(rows, 'failureCount');
    const successRate = totalMessages > 0 ? (successCount / totalMessages) * 100 : 0;
    const avgDuration = this.weightedAvg(rows, 'avgDuration', 'successCount');
    const activeUsers = this.sumField(rows, 'activeUsers');
    const activeChats = this.sumField(rows, 'activeChats');
    const totalTokenUsage = this.sumField(rows, 'totalTokenUsage');

    return {
      totalMessages,
      successCount,
      failureCount,
      successRate: Math.round(successRate * 100) / 100,
      avgDuration: Math.round(avgDuration),
      activeUsers,
      activeChats,
      totalTokenUsage,
    };
  }

  /**
   * 从小时统计聚合降级数据
   */
  async getFallbackFromHourly(startDate: Date, endDate: Date): Promise<DashboardFallbackStats> {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    const totalCount = this.sumField(rows, 'fallbackCount');
    const successCount = this.sumField(rows, 'fallbackSuccessCount');
    const successRate = totalCount > 0 ? (successCount / totalCount) * 100 : 0;

    return {
      totalCount,
      successCount,
      successRate: Math.round(successRate * 100) / 100,
      affectedUsers: 0, // 小时聚合无法精确去重，返回 0
    };
  }

  /**
   * 从小时统计聚合每日趋势
   */
  async getDailyTrendFromHourly(startDate: Date, endDate: Date): Promise<DailyTrendData[]> {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    // 按日期分组
    const dayMap = new Map<string, HourlyStats[]>();
    for (const row of rows) {
      const dateKey = new Date(row.hour).toISOString().split('T')[0];
      if (!dayMap.has(dateKey)) {
        dayMap.set(dateKey, []);
      }
      dayMap.get(dateKey)!.push(row as unknown as HourlyStats);
    }

    // 聚合每日数据
    const result: DailyTrendData[] = [];
    for (const [date, dayRows] of dayMap) {
      result.push({
        date,
        messageCount: this.sumField(dayRows, 'messageCount'),
        successCount: this.sumField(dayRows, 'successCount'),
        avgDuration: Math.round(this.weightedAvg(dayRows, 'avgDuration', 'successCount')),
        tokenUsage: this.sumField(dayRows, 'totalTokenUsage'),
        uniqueUsers: this.sumField(dayRows, 'activeUsers'),
      });
    }

    return result.sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * 从小时统计返回小时趋势（直接映射）
   */
  async getHourlyTrendFromHourly(startDate: Date, endDate: Date): Promise<HourlyTrendData[]> {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    return rows.map((row) => ({
      hour: row.hour,
      messageCount: row.messageCount,
      successCount: row.successCount,
      avgDuration: row.avgDuration,
      tokenUsage: row.totalTokenUsage,
      uniqueUsers: row.activeUsers,
    }));
  }

  /**
   * 从小时统计返回分钟趋势（降级为小时粒度）
   */
  async getMinuteTrendFromHourly(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      minute: string;
      messageCount: number;
      successCount: number;
      avgDuration: number;
      uniqueUsers: number;
    }>
  > {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    return rows.map((row) => ({
      minute: row.hour, // 历史数据降级为小时粒度
      messageCount: row.messageCount,
      successCount: row.successCount,
      avgDuration: row.avgDuration,
      uniqueUsers: row.activeUsers,
    }));
  }

  /**
   * 从小时统计聚合场景分布
   */
  async getScenarioFromHourly(
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
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    // 合并所有小时的 scenarioStats JSONB
    const scenarioMap = new Map<
      string,
      { count: number; successCount: number; totalDuration: number }
    >();

    for (const row of rows) {
      if (!row.scenarioStats) continue;
      for (const [scenario, stats] of Object.entries(row.scenarioStats)) {
        const existing = scenarioMap.get(scenario) ?? {
          count: 0,
          successCount: 0,
          totalDuration: 0,
        };
        existing.count += stats.count;
        existing.successCount += stats.successCount;
        existing.totalDuration += stats.avgDuration * stats.count;
        scenarioMap.set(scenario, existing);
      }
    }

    return Array.from(scenarioMap.entries())
      .map(([scenario, stats]) => ({
        scenario,
        count: stats.count,
        successCount: stats.successCount,
        avgDuration: stats.count > 0 ? Math.round(stats.totalDuration / stats.count) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }

  /**
   * 从小时统计聚合工具使用
   */
  async getToolFromHourly(
    startDate: Date,
    endDate: Date,
  ): Promise<
    Array<{
      toolName: string;
      useCount: number;
    }>
  > {
    const rows = await this.hourlyStatsRepository.getHourlyStatsByDateRange(startDate, endDate);

    // 合并所有小时的 toolStats JSONB
    const toolMap = new Map<string, number>();

    for (const row of rows) {
      if (!row.toolStats) continue;
      for (const [tool, count] of Object.entries(row.toolStats)) {
        toolMap.set(tool, (toolMap.get(tool) ?? 0) + count);
      }
    }

    return Array.from(toolMap.entries())
      .map(([toolName, useCount]) => ({ toolName, useCount }))
      .sort((a, b) => b.useCount - a.useCount);
  }

  // ==================== 合并工具方法 ====================

  /**
   * 合并两个 OverviewStats（用于 today 场景：历史小时 + 当前小时实时）
   */
  mergeOverviewStats(a: DashboardOverviewStats, b: DashboardOverviewStats): DashboardOverviewStats {
    const totalMessages = a.totalMessages + b.totalMessages;
    const successCount = a.successCount + b.successCount;
    const failureCount = a.failureCount + b.failureCount;
    const successRate = totalMessages > 0 ? (successCount / totalMessages) * 100 : 0;
    const avgDuration =
      successCount > 0
        ? (a.avgDuration * a.successCount + b.avgDuration * b.successCount) / successCount
        : 0;

    return {
      totalMessages,
      successCount,
      failureCount,
      successRate: Math.round(successRate * 100) / 100,
      avgDuration: Math.round(avgDuration),
      activeUsers: a.activeUsers + b.activeUsers,
      activeChats: a.activeChats + b.activeChats,
      totalTokenUsage: a.totalTokenUsage + b.totalTokenUsage,
    };
  }

  /**
   * 合并两个 FallbackStats
   */
  mergeFallbackStats(a: DashboardFallbackStats, b: DashboardFallbackStats): DashboardFallbackStats {
    const totalCount = a.totalCount + b.totalCount;
    const successCount = a.successCount + b.successCount;
    const successRate = totalCount > 0 ? (successCount / totalCount) * 100 : 0;

    return {
      totalCount,
      successCount,
      successRate: Math.round(successRate * 100) / 100,
      affectedUsers: a.affectedUsers + b.affectedUsers,
    };
  }

  // ==================== 私有辅助方法 ====================

  private sumField(rows: HourlyStats[], field: keyof HourlyStats): number {
    return rows.reduce((sum, row) => sum + ((row[field] as number) ?? 0), 0);
  }

  private weightedAvg(
    rows: HourlyStats[],
    valueField: keyof HourlyStats,
    weightField: keyof HourlyStats,
  ): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const row of rows) {
      const weight = (row[weightField] as number) ?? 0;
      const value = (row[valueField] as number) ?? 0;
      if (weight > 0) {
        weightedSum += value * weight;
        totalWeight += weight;
      }
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }
}
