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

export interface ManualInterventionStats {
  totalCount: number;
  handoffCount: number;
  riskAlertCount: number;
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
  botUserId?: string;
  imBotId?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: string;
  lastActiveAt: string;
  isPaused: boolean;
}

// ==================== 聚合数据 ====================

export type DashboardTimeRange = 'today' | 'week' | 'month' | 'twoMonths' | 'threeMonths';

export interface DashboardData {
  timeRange: DashboardTimeRange;
  overview: Overview;
  overviewDelta: OverviewDelta;
  queue: QueueInfo;
  alertsSummary: AlertSummary;
  fallback: FallbackStats;
  fallbackDelta: { totalCount: number };
  manualIntervention: ManualInterventionStats;
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
  manualIntervention?: ManualInterventionStats;
  /** 数据覆盖标注：周期起点早于数据覆盖起点时对应标记为 false，前端隐藏环比 */
  dataCoverage?: {
    startDate: string | null;
    currentPeriodCovered: boolean;
    previousPeriodCovered: boolean;
  };
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
