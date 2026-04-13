import { AnalyticsMetricsService } from '@analytics/metrics/analytics-metrics.service';
import { MonitoringErrorLog } from '@shared-types/tracking.types';

describe('AnalyticsMetricsService', () => {
  let service: AnalyticsMetricsService;

  beforeEach(() => {
    service = new AnalyticsMetricsService();
  });

  it('should calculate percentiles from a numeric array', () => {
    expect(service.calculatePercentilesFromArray([1, 2, 3, 4, 5])).toEqual({
      p50: 3,
      p95: 5,
      p99: 5,
      p999: 5,
    });
  });

  it('should calculate queue metrics from records with queue duration', () => {
    const metrics = service.calculateQueueMetrics(
      [
        { queueDuration: 100 } as never,
        { queueDuration: 300 } as never,
        { queueDuration: undefined } as never,
      ],
      4,
    );

    expect(metrics).toEqual({
      currentProcessing: 4,
      peakProcessing: 300,
      avgQueueDuration: 200,
    });
  });

  it('should summarize alert counts by time windows and type', () => {
    const now = Date.now();
    const logs: MonitoringErrorLog[] = [
      { messageId: '1', timestamp: now - 30 * 60 * 1000, error: 'a', alertType: 'agent' },
      { messageId: '2', timestamp: now - 2 * 60 * 60 * 1000, error: 'b', alertType: 'agent' },
      { messageId: '3', timestamp: now - 26 * 60 * 60 * 1000, error: 'c', alertType: 'delivery' },
    ];

    const summary = service.calculateAlertsSummary(logs);

    expect(summary.total).toBe(3);
    expect(summary.lastHour).toBe(1);
    expect(summary.last24Hours).toBe(2);
    expect(summary.byType).toEqual([
      { type: 'agent', count: 2, percentage: 66.7 },
      { type: 'delivery', count: 1, percentage: 33.3 },
    ]);
  });
});
