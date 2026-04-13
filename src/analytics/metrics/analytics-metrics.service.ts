import { Injectable } from '@nestjs/common';
import {
  AlertErrorType,
  MessageProcessingRecord,
  MonitoringErrorLog,
} from '@shared-types/tracking.types';
import { AlertTypeMetric, AlertsSummary, QueueMetrics } from '../types/analytics.types';

@Injectable()
export class AnalyticsMetricsService {
  calculatePercentilesFromArray(values: number[]): {
    p50: number;
    p95: number;
    p99: number;
    p999: number;
  } {
    if (values.length === 0) return { p50: 0, p95: 0, p99: 0, p999: 0 };
    const sorted = [...values].sort((a, b) => a - b);
    const getPercentile = (p: number) => {
      const index = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, index)] || 0;
    };
    return {
      p50: getPercentile(50),
      p95: getPercentile(95),
      p99: getPercentile(99),
      p999: getPercentile(99.9),
    };
  }

  calculateQueueMetrics(
    records: MessageProcessingRecord[],
    currentProcessing: number,
  ): QueueMetrics {
    const queueDurations = records
      .filter((record) => record.queueDuration)
      .map((record) => record.queueDuration!);
    const avgQueueDuration =
      queueDurations.length > 0
        ? queueDurations.reduce((sum, duration) => sum + duration, 0) / queueDurations.length
        : 0;

    return {
      currentProcessing,
      peakProcessing: Math.max(...queueDurations, 0),
      avgQueueDuration: parseFloat(avgQueueDuration.toFixed(0)),
    };
  }

  calculateAlertsSummary(errorLogs: MonitoringErrorLog[]): AlertsSummary {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    return {
      total: errorLogs.length,
      lastHour: errorLogs.filter((log) => log.timestamp >= oneHourAgo).length,
      last24Hours: errorLogs.filter((log) => log.timestamp >= oneDayAgo).length,
      byType: this.buildAlertTypeMetrics(errorLogs),
    };
  }

  buildAlertTypeMetrics(errorLogs: MonitoringErrorLog[]): AlertTypeMetric[] {
    const typeMap = new Map<AlertErrorType | 'unknown', number>();
    for (const log of errorLogs) {
      const type = log.alertType || 'unknown';
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
      .sort((a, b) => b.count - a.count);
  }
}
