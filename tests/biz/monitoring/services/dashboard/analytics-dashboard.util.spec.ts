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

  it('should calculate week range as recent 7 local days', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-29T02:00:00Z'));

    const range = calculateDashboardTimeRanges('week');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-04-22T16:00:00.000Z');
    expect(new Date(range.currentEnd).toISOString()).toBe('2026-04-29T02:00:00.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2026-04-15T16:00:00.000Z');
    expect(new Date(range.previousEnd).toISOString()).toBe('2026-04-22T02:00:00.000Z');
  });

  it('should calculate month range as recent 30 local days', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:54:58Z'));

    const range = calculateDashboardTimeRanges('month');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-03-29T16:00:00.000Z');
    expect(new Date(range.currentEnd).toISOString()).toBe('2026-04-28T10:54:58.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2026-02-27T16:00:00.000Z');
    expect(new Date(range.previousEnd).toISOString()).toBe('2026-03-29T10:54:58.000Z');
  });

  it('should calculate two-month range as recent 60 local days', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:54:58Z'));

    const range = calculateDashboardTimeRanges('twoMonths');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-02-27T16:00:00.000Z');
    expect(new Date(range.currentEnd).toISOString()).toBe('2026-04-28T10:54:58.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2025-12-29T16:00:00.000Z');
    expect(new Date(range.previousEnd).toISOString()).toBe('2026-02-27T10:54:58.000Z');
  });

  it('should calculate three-month range as recent 90 local days', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-28T10:54:58Z'));

    const range = calculateDashboardTimeRanges('threeMonths');

    expect(new Date(range.currentStart).toISOString()).toBe('2026-01-28T16:00:00.000Z');
    expect(new Date(range.currentEnd).toISOString()).toBe('2026-04-28T10:54:58.000Z');
    expect(new Date(range.previousStart).toISOString()).toBe('2025-10-30T16:00:00.000Z');
    expect(new Date(range.previousEnd).toISOString()).toBe('2026-01-28T10:54:58.000Z');
  });
});
