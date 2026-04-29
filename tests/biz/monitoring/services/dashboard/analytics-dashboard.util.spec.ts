import { calculateDashboardTimeRanges } from '@biz/monitoring/services/dashboard/analytics-dashboard.util';

describe('analytics-dashboard.util', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('should calculate today range from Shanghai midnight', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:54:58Z'));

    const range = calculateDashboardTimeRanges('today');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-04-27T16:00:00.000Z');
    expect(new Date(range.currentEnd).toISOString()).toBe('2026-04-28T10:54:58.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2026-04-26T16:00:00.000Z');
    expect(new Date(range.previousEnd).toISOString()).toBe('2026-04-27T10:54:58.000Z');
  });

  it('should calculate week range from Shanghai Monday midnight', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-29T02:00:00Z'));

    const range = calculateDashboardTimeRanges('week');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-04-26T16:00:00.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2026-04-19T16:00:00.000Z');
  });

  it('should calculate month range from Shanghai month start', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:54:58Z'));

    const range = calculateDashboardTimeRanges('month');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-03-31T16:00:00.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2026-02-28T16:00:00.000Z');
  });
});
