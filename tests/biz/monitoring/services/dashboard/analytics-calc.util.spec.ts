import {
  buildAlertTrend,
  buildAlertTypeMetrics,
  buildBusinessTrend,
  buildResponseTrend,
  calculateAlertsSummary,
  calculatePercentilesFromArray,
  calculateQueueMetrics,
  getTrendHours,
} from '@biz/monitoring/services/dashboard/analytics-calc.util';
import type { MessageProcessingRecord, MonitoringErrorLog } from '@shared-types/tracking.types';

function record(partial: Partial<MessageProcessingRecord>): MessageProcessingRecord {
  return {
    messageId: 'm1',
    userId: 'u1',
    receivedAt: Date.parse('2026-08-13T10:00:00+08:00'),
    status: 'success',
    ...partial,
  } as MessageProcessingRecord;
}

function errorLog(partial: Partial<MonitoringErrorLog>): MonitoringErrorLog {
  return {
    id: 'e1',
    timestamp: Date.now(),
    ...partial,
  } as MonitoringErrorLog;
}

describe('getTrendHours', () => {
  it('maps each range to its hour span', () => {
    expect(getTrendHours('today')).toBe(24);
    expect(getTrendHours('week')).toBe(168);
    expect(getTrendHours('threeMonths')).toBe(2160);
  });

  it('falls back to the month span for an unknown range', () => {
    expect(getTrendHours('nonsense' as never)).toBe(720);
  });
});

describe('calculatePercentilesFromArray', () => {
  it('returns zeros for an empty sample（空样本不能算成 0ms 的"很快"以外的东西）', () => {
    expect(calculatePercentilesFromArray([])).toEqual({ p50: 0, p95: 0, p99: 0, p999: 0 });
  });

  it('computes percentiles on a sorted copy without mutating the input', () => {
    const values = [300, 100, 200];
    const result = calculatePercentilesFromArray(values);
    expect(values).toEqual([300, 100, 200]);
    expect(result.p50).toBe(200);
    expect(result.p99).toBe(300);
  });

  it('picks the top sample for high percentiles on small arrays', () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(calculatePercentilesFromArray(values)).toMatchObject({ p50: 50, p95: 95, p99: 99 });
  });
});

describe('calculateQueueMetrics', () => {
  const realtime = { activeRequests: 3, peakActiveRequests: 9, queueWaitingJobs: 2 };

  it('averages queueDuration over records that have one', () => {
    const metrics = calculateQueueMetrics(
      [
        record({ queueDuration: 100 }),
        record({ queueDuration: 300 }),
        record({ queueDuration: undefined }),
      ],
      realtime,
    );
    expect(metrics).toEqual({ ...realtime, avgQueueDuration: 200 });
  });

  it('reports 0 rather than NaN when no record carries a queueDuration', () => {
    expect(calculateQueueMetrics([record({})], realtime).avgQueueDuration).toBe(0);
  });
});

describe('alerts summary', () => {
  it('counts totals per window', () => {
    const now = Date.now();
    const summary = calculateAlertsSummary([
      errorLog({ timestamp: now - 60_000, subsystem: 'agent' }),
      errorLog({ timestamp: now - 5 * 60 * 60 * 1000, subsystem: 'agent' }),
      errorLog({ timestamp: now - 3 * 24 * 60 * 60 * 1000, subsystem: 'memory' }),
    ]);
    expect(summary.total).toBe(3);
    expect(summary.lastHour).toBe(1);
    expect(summary.last24Hours).toBe(2);
  });

  it('buildAlertTypeMetrics prefers subsystem, falls back to alertType then unknown', () => {
    const metrics = buildAlertTypeMetrics([
      errorLog({ subsystem: 'agent' }),
      errorLog({ subsystem: 'agent' }),
      errorLog({ subsystem: undefined, alertType: 'delivery' }),
      errorLog({ subsystem: undefined, alertType: undefined }),
    ]);
    expect(metrics[0]).toEqual({ type: 'agent', count: 2, percentage: 50 });
    expect(metrics.map((metric) => metric.type)).toEqual(
      expect.arrayContaining(['agent', 'delivery', 'unknown']),
    );
  });

  it('buildAlertTypeMetrics returns [] with no logs（不产出 0 分母的百分比）', () => {
    expect(buildAlertTypeMetrics([])).toEqual([]);
  });
});

describe('buildResponseTrend', () => {
  it('buckets by day outside today and reports avg duration + success rate', () => {
    const trend = buildResponseTrend(
      [
        record({ totalDuration: 1000, status: 'success' }),
        record({ totalDuration: 3000, status: 'failure' }),
      ],
      'week',
    );
    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({ avgDuration: 2000, messageCount: 2, successRate: 50 });
  });

  it('excludes in-flight records（processing 没有终态耗时，计进去会拉低均值）', () => {
    const trend = buildResponseTrend(
      [
        record({ totalDuration: 1000, status: 'success' }),
        record({ totalDuration: 9999, status: 'processing' }),
        record({ totalDuration: undefined, status: 'success' }),
      ],
      'week',
    );
    expect(trend[0].messageCount).toBe(1);
  });

  it('sorts buckets chronologically by key', () => {
    const trend = buildResponseTrend(
      [
        record({ receivedAt: Date.parse('2026-08-14T10:00:00+08:00'), totalDuration: 100 }),
        record({ receivedAt: Date.parse('2026-08-12T10:00:00+08:00'), totalDuration: 100 }),
      ],
      'week',
    );
    expect(trend.map((point) => point.minute)).toEqual([...trend.map((p) => p.minute)].sort());
  });
});

describe('buildAlertTrend', () => {
  it('counts logs per bucket in chronological order', () => {
    const trend = buildAlertTrend(
      [
        errorLog({ timestamp: Date.parse('2026-08-12T10:00:00+08:00') }),
        errorLog({ timestamp: Date.parse('2026-08-13T10:00:00+08:00') }),
        errorLog({ timestamp: Date.parse('2026-08-13T18:00:00+08:00') }),
      ],
      'week',
    );
    expect(trend).toHaveLength(2);
    expect(trend[1].count).toBe(2);
  });
});

describe('buildBusinessTrend', () => {
  it('counts unique users as consultations and booking calls from top-level toolCalls', () => {
    const trend = buildBusinessTrend(
      [
        record({
          userId: 'u1',
          toolCalls: [
            { toolName: 'duliday_interview_booking', result: { success: true } },
            { toolName: 'duliday_interview_booking', result: { success: false } },
            { toolName: 'duliday_job_list', result: { success: true } },
          ],
        } as Partial<MessageProcessingRecord>),
        record({ userId: 'u1' }),
        record({ userId: 'u2' }),
      ],
      'week',
    );

    expect(trend).toHaveLength(1);
    expect(trend[0]).toMatchObject({
      consultations: 2,
      bookingAttempts: 2,
      successfulBookings: 1,
      bookingSuccessRate: 50,
      conversionRate: 100,
    });
  });

  it('reads booking results from the AI-SDK message parts when toolCalls is empty（旧形态兼容）', () => {
    const trend = buildBusinessTrend(
      [
        record({
          userId: 'u1',
          toolCalls: [],
          agentInvocation: {
            response: {
              messages: [
                {
                  parts: [
                    {
                      type: 'dynamic-tool',
                      toolName: 'duliday_interview_booking',
                      state: 'output-available',
                      output: { type: 'object', object: { success: true } },
                    },
                  ],
                },
              ],
            },
          },
        } as unknown as Partial<MessageProcessingRecord>),
      ],
      'week',
    );
    expect(trend[0]).toMatchObject({ bookingAttempts: 1, successfulBookings: 1 });
  });

  it('reports 0 rates rather than NaN when there is nothing to divide by', () => {
    const trend = buildBusinessTrend([record({ userId: undefined })], 'week');
    expect(trend[0]).toMatchObject({ conversionRate: 0, bookingSuccessRate: 0 });
  });
});
