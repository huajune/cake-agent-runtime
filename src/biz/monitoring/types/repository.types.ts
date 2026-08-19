/**
 * Repository 层类型定义
 * 应用层映射格式（camelCase）
 */

import {
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
  HourlyTrendData,
  DailyProjectionStats,
  HourlyStats,
} from './analytics.types';

// Re-export analytics types used by repositories
export type { DashboardOverviewStats, DashboardFallbackStats, DailyTrendData, HourlyTrendData };

// Re-export entity types for backward compatibility
export type { HourlyStatsDbRecord } from '../entities/hourly-stats.entity';
export type { DailyStatsDbRecord } from '../entities/daily-stats.entity';
export type { ErrorLogDbRecord } from '../entities/error-log.entity';

// ========================================
// 应用层映射格式（camelCase）
// ========================================

/** 小时统计应用层格式与 Dashboard 聚合模型同源。 */
export type HourlyStatsRecord = HourlyStats;

/**
 * 日统计应用层格式
 */
export type DailyStatsRecord = DailyProjectionStats;

/**
 * 错误日志应用层格式（与 MonitoringErrorLog 相同，type alias 统一为一个定义）
 */
export type { MonitoringErrorLog as ErrorLogRecord } from '@shared-types/tracking.types';
