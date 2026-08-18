import { formatLocalDate, formatLocalMinute } from '@infra/utils/date.util';
import { asRecord } from '@infra/utils/object.util';
import type { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';
import type {
  AlertTrendPoint,
  AlertTypeMetric,
  BusinessMetricTrendPoint,
  ResponseMinuteTrendPoint,
  TimeRange,
} from '../../types/analytics.types';

const TREND_HOURS_BY_RANGE: Record<TimeRange, number> = {
  today: 24,
  week: 168,
  month: 720,
  twoMonths: 1440,
  threeMonths: 2160,
};

export function getTrendHours(timeRange: TimeRange): number {
  return TREND_HOURS_BY_RANGE[timeRange] ?? TREND_HOURS_BY_RANGE.month;
}

export function calculatePercentilesFromArray(values: number[]): {
  p50: number;
  p95: number;
  p99: number;
  p999: number;
} {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, p999: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const getPercentile = (percentile: number) => {
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)] || 0;
  };
  return {
    p50: getPercentile(50),
    p95: getPercentile(95),
    p99: getPercentile(99),
    p999: getPercentile(99.9),
  };
}

export function calculateQueueMetrics(
  records: MessageProcessingRecord[],
  realtime: {
    activeRequests: number;
    peakActiveRequests: number;
    queueWaitingJobs: number;
  },
) {
  const queueDurations = records
    .filter((record) => record.queueDuration)
    .map((record) => record.queueDuration!);
  const avgQueueDuration =
    queueDurations.length > 0
      ? queueDurations.reduce((sum, duration) => sum + duration, 0) / queueDurations.length
      : 0;

  return {
    activeRequests: realtime.activeRequests,
    peakActiveRequests: realtime.peakActiveRequests,
    queueWaitingJobs: realtime.queueWaitingJobs,
    avgQueueDuration: parseFloat(avgQueueDuration.toFixed(0)),
  };
}

export function calculateAlertsSummary(errorLogs: MonitoringErrorLog[]) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  return {
    total: errorLogs.length,
    lastHour: errorLogs.filter((log) => log.timestamp >= oneHourAgo).length,
    last24Hours: errorLogs.filter((log) => log.timestamp >= oneDayAgo).length,
    byType: buildAlertTypeMetrics(errorLogs),
  };
}

export function buildAlertTypeMetrics(errorLogs: MonitoringErrorLog[]): AlertTypeMetric[] {
  const typeMap = new Map<string, number>();
  for (const log of errorLogs) {
    const type = log.subsystem || log.alertType || 'unknown';
    typeMap.set(type, (typeMap.get(type) || 0) + 1);
  }
  const total = Array.from(typeMap.values()).reduce((sum, count) => sum + count, 0);
  if (total === 0) return [];
  return Array.from(typeMap.entries())
    .map(([type, count]) => ({
      type,
      count,
      percentage: parseFloat(((count / total) * 100).toFixed(1)),
    }))
    .sort((left, right) => right.count - left.count);
}

export function buildResponseTrend(
  records: MessageProcessingRecord[],
  timeRange: TimeRange,
): ResponseMinuteTrendPoint[] {
  const keyFn =
    timeRange === 'today'
      ? (record: MessageProcessingRecord) => formatLocalMinute(new Date(record.receivedAt))
      : (record: MessageProcessingRecord) => formatLocalDate(new Date(record.receivedAt));
  const buckets = new Map<string, { durations: number[]; success: number; total: number }>();

  for (const record of records) {
    if (record.status === 'processing' || record.totalDuration === undefined) continue;
    const key = keyFn(record);
    const bucket = buckets.get(key) || { durations: [], success: 0, total: 0 };
    bucket.durations.push(record.totalDuration || 0);
    bucket.total += 1;
    if (record.status === 'success') bucket.success += 1;
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([minute, bucket]) => ({
      minute,
      avgDuration:
        bucket.durations.length > 0
          ? parseFloat(
              (
                bucket.durations.reduce((sum, duration) => sum + duration, 0) /
                bucket.durations.length
              ).toFixed(2),
            )
          : 0,
      messageCount: bucket.total,
      successRate:
        bucket.total > 0 ? parseFloat(((bucket.success / bucket.total) * 100).toFixed(2)) : 0,
    }));
}

export function buildAlertTrend(
  logs: MonitoringErrorLog[],
  timeRange: TimeRange,
): AlertTrendPoint[] {
  const keyFn = timeRange === 'today' ? formatLocalMinute : formatLocalDate;
  const buckets = new Map<string, number>();

  for (const log of logs) {
    const key = keyFn(new Date(log.timestamp));
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }

  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([minute, count]) => ({ minute, count }));
}

export function buildBusinessTrend(
  records: MessageProcessingRecord[],
  timeRange: TimeRange,
): BusinessMetricTrendPoint[] {
  const keyFn =
    timeRange === 'today'
      ? (record: MessageProcessingRecord) => formatLocalMinute(new Date(record.receivedAt))
      : (record: MessageProcessingRecord) => formatLocalDate(new Date(record.receivedAt));
  const buckets = new Map<
    string,
    { users: Set<string>; bookingAttempts: number; successfulBookings: number }
  >();

  for (const record of records) {
    const key = keyFn(record);
    const bucket = buckets.get(key) || {
      users: new Set<string>(),
      bookingAttempts: 0,
      successfulBookings: 0,
    };

    if (record.userId) bucket.users.add(record.userId);

    for (const result of getBookingToolCallResults(record)) {
      bucket.bookingAttempts += 1;
      if (isBookingOutputSuccess(result)) {
        bucket.successfulBookings += 1;
      }
    }

    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([minute, bucket]) => {
      const consultations = bucket.users.size;
      const bookingAttempts = bucket.bookingAttempts;
      const successfulBookings = bucket.successfulBookings;
      return {
        minute,
        consultations,
        bookingAttempts,
        successfulBookings,
        conversionRate:
          consultations > 0 ? parseFloat(((bookingAttempts / consultations) * 100).toFixed(2)) : 0,
        bookingSuccessRate:
          bookingAttempts > 0
            ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
            : 0,
      };
    });
}

function isBookingOutputSuccess(output: unknown): boolean {
  const record = asRecord(output);
  if (!record) return false;

  if (record.type === 'object' && record.object) {
    return asRecord(record.object)?.success === true;
  }
  return record.success === true;
}

function getBookingToolCallResults(record: MessageProcessingRecord): unknown[] {
  const topLevelCalls = (record.toolCalls ?? [])
    .filter((call) => {
      const toolName =
        (call as { toolName?: string; name?: string }).toolName ??
        (call as { toolName?: string; name?: string }).name;
      return toolName === 'duliday_interview_booking';
    })
    .map((call) => call.result);

  if (topLevelCalls.length > 0) {
    return topLevelCalls;
  }

  const response = record.agentInvocation?.response;
  const legacyToolCalls = response?.toolCalls;

  if (Array.isArray(legacyToolCalls)) {
    return legacyToolCalls
      .filter((call) => call?.toolName === 'duliday_interview_booking')
      .map((call) => call.result);
  }

  if (!Array.isArray(response?.messages)) {
    return [];
  }

  const results: unknown[] = [];
  for (const message of response.messages) {
    if (!Array.isArray(message.parts)) continue;
    for (const part of message.parts) {
      if (
        part.type === 'dynamic-tool' &&
        part.toolName === 'duliday_interview_booking' &&
        part.state === 'output-available'
      ) {
        results.push(part.output);
      }
    }
  }

  return results;
}
