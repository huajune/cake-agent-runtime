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
      {
        activeRequests: 4,
        peakActiveRequests: 9,
        queueWaitingJobs: 2,
      },
    );

    expect(metrics).toEqual({
      activeRequests: 4,
      peakActiveRequests: 9,
      queueWaitingJobs: 2,
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

  it('groups by subsystem when present, falling back to alertType for legacy rows', () => {
    const now = Date.now();
    const logs: MonitoringErrorLog[] = [
      // 新子系统告警：按 subsystem 分组
      { timestamp: now, error: 'a', alertType: 'system', subsystem: 'group-task' },
      { timestamp: now, error: 'b', alertType: 'system', subsystem: 'group-task' },
      { timestamp: now, error: 'c', alertType: 'system', subsystem: 'cron' },
      // 老消息失败无 subsystem：回退 alertType 保留粒度
      { messageId: '1', timestamp: now, error: 'd', alertType: 'agent' },
    ];

    const summary = service.calculateAlertsSummary(logs);

    expect(summary.byType).toEqual([
      { type: 'group-task', count: 2, percentage: 50 },
      { type: 'cron', count: 1, percentage: 25 },
      { type: 'agent', count: 1, percentage: 25 },
    ]);
  });
});
