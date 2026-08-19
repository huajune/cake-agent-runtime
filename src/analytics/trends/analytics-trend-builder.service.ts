import { Injectable } from '@nestjs/common';
import type { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';
import {
  buildAlertTrend,
  buildBusinessTrend,
  buildResponseTrend,
} from '@biz/monitoring/services/dashboard/analytics-calc.util';
import type {
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
    return buildResponseTrend(records, timeRange);
  }

  buildAlertTrend(logs: MonitoringErrorLog[], timeRange: AnalyticsTimeRange): AlertTrendPoint[] {
    return buildAlertTrend(logs, timeRange);
  }

  buildBusinessTrend(
    records: MessageProcessingRecord[],
    timeRange: AnalyticsTimeRange,
  ): BusinessMetricTrendPoint[] {
    return buildBusinessTrend(records, timeRange);
  }
}
