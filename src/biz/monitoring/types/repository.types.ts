/**
 * Repository 层类型定义
 * 应用层映射格式（camelCase）
 */

import { AlertErrorType } from './tracking.types';
import {
  DashboardOverviewStats,
  DashboardFallbackStats,
  DailyTrendData,
  HourlyTrendData,
} from './analytics.types';

// Re-export analytics types used by repositories
export type { DashboardOverviewStats, DashboardFallbackStats, DailyTrendData, HourlyTrendData };

// Re-export entity types for backward compatibility
export type { HourlyStatsDbRecord } from '../entities/hourly-stats.entity';
export type { ErrorLogDbRecord } from '../entities/error-log.entity';

// ========================================
// 应用层映射格式（camelCase）
// ========================================

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
 * 错误日志应用层格式
 */
export interface ErrorLogRecord {
  messageId: string;
  timestamp: number;
  error: string;
  alertType?: AlertErrorType;
}
