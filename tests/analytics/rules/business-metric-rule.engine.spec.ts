import { AlertLevel } from '@enums/alert.enum';
import { BusinessMetricRuleEngine } from '@analytics/rules/business-metric-rule.engine';

describe('BusinessMetricRuleEngine', () => {
  let service: BusinessMetricRuleEngine;

  beforeEach(() => {
    service = new BusinessMetricRuleEngine();
  });

  it('should skip sample-based alerts below the min sample threshold but still evaluate queue and errors', () => {
    const alerts = service.evaluate({
      snapshot: {
        totalMessages: 4,
        successRate: 10,
        avgDuration: 20000,
        activeRequests: 8,
        errorCountLast24Hours: 120,
      },
      minSamples: 10,
      thresholds: {
        successRateCritical: 70,
        avgDurationCritical: 10000,
        queueDepthCritical: 6,
        errorRateCritical: 4,
      },
    });

    expect(alerts).toEqual([
      expect.objectContaining({ key: 'queue-depth', level: AlertLevel.CRITICAL }),
      expect.objectContaining({ key: 'error-rate', level: AlertLevel.CRITICAL }),
    ]);
  });

  it('should emit critical alerts when metrics exceed critical thresholds', () => {
    const alerts = service.evaluate({
      snapshot: {
        totalMessages: 100,
        successRate: 60,
        avgDuration: 12000,
        activeRequests: 10,
        errorCountLast24Hours: 144,
      },
      minSamples: 10,
      thresholds: {
        successRateCritical: 70,
        avgDurationCritical: 10000,
        queueDepthCritical: 6,
        errorRateCritical: 4,
      },
    });

    expect(alerts).toEqual([
      expect.objectContaining({ key: 'success-rate', level: AlertLevel.CRITICAL }),
      expect.objectContaining({ key: 'avg-duration', level: AlertLevel.CRITICAL }),
      expect.objectContaining({ key: 'queue-depth', level: AlertLevel.CRITICAL }),
      expect.objectContaining({ key: 'error-rate', level: AlertLevel.CRITICAL }),
    ]);
  });

  it('should emit warnings when metrics are between warning and critical thresholds', () => {
    const alerts = service.evaluate({
      snapshot: {
        totalMessages: 100,
        successRate: 75,
        avgDuration: 6000,
        activeRequests: 4,
        errorCountLast24Hours: 60,
      },
      minSamples: 10,
      thresholds: {
        successRateCritical: 70,
        avgDurationCritical: 10000,
        queueDepthCritical: 6,
        errorRateCritical: 4,
      },
    });

    expect(alerts).toEqual([
      expect.objectContaining({ key: 'success-rate', level: AlertLevel.WARNING }),
      expect.objectContaining({ key: 'avg-duration', level: AlertLevel.WARNING }),
      expect.objectContaining({ key: 'queue-depth', level: AlertLevel.WARNING }),
      expect.objectContaining({ key: 'error-rate', level: AlertLevel.WARNING }),
    ]);
  });
});
