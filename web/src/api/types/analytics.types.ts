import type { MessageRecord } from './chat.types';

// ==================== Dashboard 概览 ====================

export interface Overview {
  totalMessages: number;
  successCount: number;
  successRate: number;
  avgDuration: number;
  activeUsers: number;
  activeChats: number;
}

export interface OverviewDelta {
  totalMessages: number;
  successRate: number;
  avgDuration: number;
  activeUsers: number;
}

export interface QueueInfo {
  activeRequests: number;
  peakActiveRequests: number;
  queueWaitingJobs: number;
  avgQueueDuration: number;
}

export interface AlertSummary {
  total: number;
  lastHour: number;
  last24Hours: number;
  byType: AlertTypeItem[];
}

export interface AlertTypeItem {
  type: string;
  count: number;
  percentage: number;
}

export interface FallbackStats {
  totalCount: number;
  successCount: number;
  successRate: number;
}

export interface BusinessMetrics {
  consultations: {
    total: number;
    new: number;
  };
  bookings: {
    attempts: number;
    successful: number;
    failed: number;
    successRate: number;
  };
  conversion: {
    consultationToBooking: number;
  };
}

export interface TrendPoint {
  minute: string;
  avgDuration?: number;
  count?: number;
  consultations?: number;
  bookingAttempts?: number;
  bookingSuccessRate?: number;
}

export interface DailyTrendPoint {
  date: string;
  tokenUsage: number;
  uniqueUsers: number;
}

export interface TodayUser {
  chatId: string;
  odId: string;
  odName?: string;
  groupName?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: string;
  lastActiveAt: string;
  isPaused: boolean;
}

// ==================== 聚合数据 ====================

export interface DashboardData {
  timeRange: 'today' | 'week' | 'month';
  overview: Overview;
  overviewDelta: OverviewDelta;
  queue: QueueInfo;
  alertsSummary: AlertSummary;
  fallback: FallbackStats;
  fallbackDelta: { totalCount: number };
  business: BusinessMetrics;
  businessDelta: {
    consultations: number;
    bookingAttempts: number;
    bookingSuccessRate: number;
  };
  responseTrend: TrendPoint[];
  alertTrend: TrendPoint[];
  businessTrend: TrendPoint[];
  dailyTrend: DailyTrendPoint[];
  recentMessages: MessageRecord[];
  todayUsers: TodayUser[];
}

export interface MetricsData {
  detailRecords: MessageRecord[];
  hourlyStats: any[];
  globalCounters: any;
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
    p999: number;
  };
  slowestRecords: MessageRecord[];
  recentAlertCount: number;
}

// ==================== Dashboard API 响应类型 ====================

export interface DashboardOverviewData {
  timeRange: string;
  overview: any;
  overviewDelta: any;
  dailyTrend: any[];
  tokenTrend: any[];
  businessTrend: any[];
  responseTrend: any[];
  business: any;
  businessDelta: any;
  fallback: any;
  fallbackDelta: any;
}

export interface SystemMonitoringData {
  queue: QueueInfo;
  alertsSummary: any;
  alertTrend: any[];
}

export interface TrendsData {
  dailyTrend: any;
  responseTrend: any[];
  alertTrend: any[];
  businessTrend: any[];
}
