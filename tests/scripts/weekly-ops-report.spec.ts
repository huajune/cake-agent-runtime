const { parseWindowBoundary } = require('../../scripts/weekly-ops-report/collect-badcase-stats');

describe('weekly ops report window parsing', () => {
  it('treats a date-only CLI boundary as local midnight', () => {
    const parsed = parseWindowBoundary('2026-07-27', new Date(0));

    expect(parsed.getTime()).toBe(new Date(2026, 6, 27, 0, 0, 0, 0).getTime());
  });

  it('preserves an explicit timezone in a timestamp boundary', () => {
    const parsed = parseWindowBoundary('2026-07-27T00:00:00+08:00', new Date(0));

    expect(parsed.toISOString()).toBe('2026-07-26T16:00:00.000Z');
  });

  it('rejects invalid CLI boundaries', () => {
    expect(() => parseWindowBoundary('not-a-date', new Date(0))).toThrow('无效日期边界');
  });
});
