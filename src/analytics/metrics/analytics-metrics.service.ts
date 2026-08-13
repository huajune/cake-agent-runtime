import { Injectable } from '@nestjs/common';
import type { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';
import {
  buildAlertTypeMetrics,
  calculateAlertsSummary,
  calculatePercentilesFromArray,
  calculateQueueMetrics,
} from '@biz/monitoring/services/dashboard/analytics-calc.util';
import type { AlertTypeMetric, AlertsSummary, QueueMetrics } from '../types/analytics.types';

@Injectable()
export class AnalyticsMetricsService {
  calculatePercentilesFromArray(values: number[]) {
    return calculatePercentilesFromArray(values);
  }

  calculateQueueMetrics(
    records: MessageProcessingRecord[],
    realtime: {
      activeRequests: number;
      peakActiveRequests: number;
      queueWaitingJobs: number;
    },
  ): QueueMetrics {
    return calculateQueueMetrics(records, realtime);
  }

  calculateAlertsSummary(errorLogs: MonitoringErrorLog[]): AlertsSummary {
    return calculateAlertsSummary(errorLogs);
  }

  buildAlertTypeMetrics(errorLogs: MonitoringErrorLog[]): AlertTypeMetric[] {
    return buildAlertTypeMetrics(errorLogs);
  }
}
