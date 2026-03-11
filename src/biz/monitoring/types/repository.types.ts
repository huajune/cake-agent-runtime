/**
 * Repository 层类型定义
 * 数据库记录格式 + 应用层映射格式
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

// ========================================
// 数据库行格式（snake_case，对应 Supabase 表）
// ========================================

/**
 * @table monitoring_hourly_stats
 */
export interface HourlyStatsDbRecord {
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
 * @table monitoring_error_logs
 */
export interface ErrorLogDbRecord {
  message_id: string;
  timestamp: number;
  error: string;
  alert_type?: string;
}

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
