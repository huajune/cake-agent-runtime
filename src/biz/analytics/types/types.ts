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
 * 错误日志告警类型
 */
export type ErrorLogAlertType = 'agent' | 'message' | 'delivery' | 'system' | 'merge' | 'unknown';

/**
 * 错误日志应用层格式
 */
export interface ErrorLogRecord {
  messageId: string;
  timestamp: number;
  error: string;
  alertType?: ErrorLogAlertType;
}
