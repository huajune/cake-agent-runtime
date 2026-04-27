import { Injectable } from '@nestjs/common';
import { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';
import {
  AlertTrendPoint,
  AnalyticsTimeRange,
  BusinessMetricTrendPoint,
  ResponseMinuteTrendPoint,
} from '../types/analytics.types';

@Injectable()
export class AnalyticsTrendBuilderService {
  buildResponseTrend(
    records: MessageProcessingRecord[],
    timeRange: AnalyticsTimeRange,
  ): ResponseMinuteTrendPoint[] {
    return timeRange === 'today'
      ? this.buildBucketTrend(records, (record) => this.getMinuteKey(record.receivedAt))
      : this.buildBucketTrend(records, (record) => this.getDayKey(record.receivedAt));
  }

  buildAlertTrend(logs: MonitoringErrorLog[], timeRange: AnalyticsTimeRange): AlertTrendPoint[] {
    const keyFn = timeRange === 'today' ? this.getMinuteKey : this.getDayKey;
    const buckets = new Map<string, number>();

    for (const log of logs) {
      const key = keyFn.call(this, log.timestamp);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, count]) => ({ minute, count }));
  }

  buildBusinessTrend(
    records: MessageProcessingRecord[],
    timeRange: AnalyticsTimeRange,
  ): BusinessMetricTrendPoint[] {
    const keyFn =
      timeRange === 'today'
        ? (record: MessageProcessingRecord) => this.getMinuteKey(record.receivedAt)
        : (record: MessageProcessingRecord) => this.getDayKey(record.receivedAt);

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

      for (const result of this.getBookingToolCallResults(record)) {
        bucket.bookingAttempts += 1;
        if (this.checkBookingOutputSuccess(result)) {
          bucket.successfulBookings += 1;
        }
      }

      buckets.set(key, bucket);
    }

    return Array.from(buckets.entries())
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
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
            consultations > 0
              ? parseFloat(((bookingAttempts / consultations) * 100).toFixed(2))
              : 0,
          bookingSuccessRate:
            bookingAttempts > 0
              ? parseFloat(((successfulBookings / bookingAttempts) * 100).toFixed(2))
              : 0,
        };
      });
  }

  private buildBucketTrend(
    records: MessageProcessingRecord[],
    keyFn: (record: MessageProcessingRecord) => string,
  ): ResponseMinuteTrendPoint[] {
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
      .sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
      .map(([minute, bucket]) => ({
        minute,
        avgDuration:
          bucket.durations.length > 0
            ? parseFloat(
                (
                  bucket.durations.reduce((sum, value) => sum + value, 0) / bucket.durations.length
                ).toFixed(2),
              )
            : 0,
        messageCount: bucket.total,
        successRate:
          bucket.total > 0 ? parseFloat(((bucket.success / bucket.total) * 100).toFixed(2)) : 0,
      }));
  }

  private checkBookingOutputSuccess(output: unknown): boolean {
    if (!output || typeof output !== 'object') {
      return false;
    }

    if (
      (output as Record<string, unknown>).type === 'object' &&
      (output as Record<string, unknown>).object
    ) {
      const obj = (output as Record<string, unknown>).object as Record<string, unknown>;
      return obj.success === true;
    }
    return (output as Record<string, unknown>).success === true;
  }

  private getBookingToolCallResults(record: MessageProcessingRecord): unknown[] {
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

  private getMinuteKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${year}-${month}-${day} ${hours}:${minutes}`;
  }

  private getDayKey(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
}
