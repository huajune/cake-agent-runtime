/**
 * Analytics 服务类型定义
 * Dashboard 数据聚合、趋势计算、告警指标
 */

import {
  AlertErrorType,
  MessageProcessingRecord,
  MonitoringErrorLog,
  MonitoringGlobalCounters,
} from '@shared-types/tracking.types';

// ========================================
// 基础类型
// ========================================

export type TimeRange = 'today' | 'week' | 'month';

// ========================================
// Dashboard 概览
// ========================================

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

export interface DashboardFallbackStats {
  totalCount: number;
  successCount: number;
  successRate: number;
  affectedUsers: number;
}

// ========================================
// 趋势数据
// ========================================

export interface DailyTrendData {
  date: string;
  messageCount: number;
  successCount: number;
  avgDuration: number;
  tokenUsage: number;
  uniqueUsers: number;
}

export interface HourlyTrendData {
  hour: string;
  messageCount: number;
  successCount: number;
  avgDuration: number;
  tokenUsage: number;
  uniqueUsers: number;
}

export interface ResponseMinuteTrendPoint {
  minute: string;
  avgDuration: number;
  messageCount: number;
  successRate: number;
}

export interface AlertTrendPoint {
  minute: string;
  count: number;
}

export interface BusinessMetricTrendPoint {
  minute: string;
  consultations: number;
  bookingAttempts: number;
  successfulBookings: number;
  conversionRate: number;
  bookingSuccessRate: number;
}

// ========================================
// 统计指标
// ========================================

export interface ToolUsageMetric {
  name: string;
  total: number;
  percentage: number;
}

export interface ScenarioUsageMetric {
  name: string;
  total: number;
  percentage: number;
}

export interface AlertTypeMetric {
  type: AlertErrorType | 'unknown';
  count: number;
  percentage: number;
}

export interface DailyStats {
  date: string;
  tokenUsage: number;
  uniqueUsers: number;
  messageCount: number;
  successCount: number;
  avgDuration: number;
}

export interface TodayUser {
  odId: string;
  odName: string;
  groupId?: string;
  groupName?: string;
  chatId: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number;
  lastActiveAt: number;
  isPaused: boolean;
}

// ========================================
// 小时级聚合
// ========================================

export interface HourlyStats {
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

// ========================================
// Dashboard 完整响应 DTO
// ========================================

export interface DashboardData {
  timeRange: TimeRange;
  lastWindowHours: number;

  overview: {
    totalMessages: number;
    successCount: number;
    failureCount: number;
    successRate: number;
    avgDuration: number;
    activeChats: number;
  };

  overviewDelta: {
    totalMessages: number;
    successRate: number;
    avgDuration: number;
  };

  fallback: {
    totalCount: number;
    successCount: number;
    successRate: number;
    affectedUsers: number;
  };

  fallbackDelta: {
    totalCount: number;
    successRate: number;
  };

  business: {
    consultations: { total: number; new: number };
    bookings: {
      attempts: number;
      successful: number;
      failed: number;
      successRate: number;
    };
    conversion: { consultationToBooking: number };
  };

  businessDelta: {
    consultations: number;
    bookingAttempts: number;
    bookingSuccessRate: number;
  };

  usage: {
    tools: ToolUsageMetric[];
    scenarios: ScenarioUsageMetric[];
  };

  queue: {
    activeRequests: number;
    peakActiveRequests: number;
    queueWaitingJobs: number;
    avgQueueDuration: number;
  };

  alertsSummary: {
    total: number;
    lastHour: number;
    last24Hours: number;
    byType: AlertTypeMetric[];
  };

  trends: { hourly: HourlyStats[] };

  responseTrend: ResponseMinuteTrendPoint[];
  alertTrend: AlertTrendPoint[];
  businessTrend: BusinessMetricTrendPoint[];

  todayUsers: TodayUser[];
  recentMessages: MessageProcessingRecord[];
  recentErrors: MonitoringErrorLog[];

  realtime: {
    activeRequests: number;
    lastMessageTime?: number;
  };
}

/**
 * 详细指标数据
 */
export interface MetricsData {
  detailRecords: MessageProcessingRecord[];
  hourlyStats: HourlyStats[];
  globalCounters: MonitoringGlobalCounters;
  percentiles: { p50: number; p95: number; p99: number; p999: number };
  slowestRecords: MessageProcessingRecord[];
  recentAlertCount: number;
}
