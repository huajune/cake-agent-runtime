import {
  AlertErrorType,
  MessageProcessingRecord,
  MonitoringErrorLog,
} from '@shared-types/tracking.types';

export type AnalyticsTimeRange = 'today' | 'week' | 'month';

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

export interface AlertTypeMetric {
  type: AlertErrorType | 'unknown';
  count: number;
  percentage: number;
}

export interface AlertsSummary {
  total: number;
  lastHour: number;
  last24Hours: number;
  byType: AlertTypeMetric[];
}

export interface QueueMetrics {
  activeRequests: number;
  peakActiveRequests: number;
  queueWaitingJobs: number;
  avgQueueDuration: number;
}

export type AnalyticsRecord = MessageProcessingRecord;
export type AnalyticsErrorLog = MonitoringErrorLog;
