import {
  formatLocalDate,
  formatLocalDateTime,
  formatLocalMinute,
  getLocalDayStart,
  getLocalHourStart,
  getLocalMonthStart,
  getLocalWeekStart,
  getTomorrowDate,
  parseLocalDateStart,
} from '@infra/utils/date.util';

describe('date.util (Asia/Shanghai)', () => {
  describe('formatLocalDate', () => {
    it('should return YYYY-MM-DD format', () => {
      const date = new Date('2026-03-27T10:00:00+08:00');
      expect(formatLocalDate(date)).toBe('2026-03-27');
    });

    it('should use Shanghai timezone — UTC 16:00 = Shanghai next day 00:00', () => {
      // 2024-01-01 16:00 UTC = 2024-01-02 00:00 Shanghai
      const date = new Date('2024-01-01T16:00:00Z');
      expect(formatLocalDate(date)).toBe('2024-01-02');
    });

    it('should use Shanghai timezone — UTC 15:59 = Shanghai same day 23:59', () => {
      const date = new Date('2024-01-01T15:59:00Z');
      expect(formatLocalDate(date)).toBe('2024-01-01');
    });

    it('should pad single-digit month and day', () => {
      const date = new Date('2026-01-05T08:00:00+08:00');
      expect(formatLocalDate(date)).toBe('2026-01-05');
    });
  });

  describe('formatLocalDateTime', () => {
    it('should return YYYY-MM-DD HH:mm:ss format', () => {
      const date = new Date('2026-03-27T14:30:45+08:00');
      expect(formatLocalDateTime(date)).toBe('2026-03-27 14:30:45');
    });

    it('should use Shanghai timezone for datetime', () => {
      // 2026-06-15 18:30:00 UTC = 2026-06-16 02:30:00 Shanghai
      const date = new Date('2026-06-15T18:30:00Z');
      expect(formatLocalDateTime(date)).toBe('2026-06-16 02:30:00');
    });

    it('should use 24-hour format', () => {
      const date = new Date('2026-03-27T23:05:09+08:00');
      expect(formatLocalDateTime(date)).toBe('2026-03-27 23:05:09');
    });
  });

  describe('formatLocalMinute', () => {
    it('should format UTC instants as Shanghai minute labels', () => {
      expect(formatLocalMinute(new Date('2026-04-28T10:11:30Z'))).toBe('2026-04-28 18:11');
    });
  });

  describe('local period starts', () => {
    it('should return Shanghai day start as an absolute instant', () => {
      expect(getLocalDayStart(new Date('2026-04-28T10:11:30Z')).toISOString()).toBe(
        '2026-04-27T16:00:00.000Z',
      );
    });

    it('should return Shanghai hour start as an absolute instant', () => {
      expect(getLocalHourStart(new Date('2026-04-28T10:11:30Z')).toISOString()).toBe(
        '2026-04-28T10:00:00.000Z',
      );
    });

    it('should return Shanghai week start on Monday', () => {
      expect(getLocalWeekStart(new Date('2026-04-29T02:00:00Z')).toISOString()).toBe(
        '2026-04-26T16:00:00.000Z',
      );
    });

    it('should return Shanghai month start with offsets', () => {
      expect(getLocalMonthStart(new Date('2026-04-28T10:11:30Z')).toISOString()).toBe(
        '2026-03-31T16:00:00.000Z',
      );
      expect(getLocalMonthStart(new Date('2026-04-28T10:11:30Z'), -1).toISOString()).toBe(
        '2026-02-28T16:00:00.000Z',
      );
    });

    it('should parse YYYY-MM-DD as Shanghai day start', () => {
      expect(parseLocalDateStart('2026-04-28').toISOString()).toBe(
        '2026-04-27T16:00:00.000Z',
      );
    });
  });

  describe('getTomorrowDate', () => {
    it('should return a valid YYYY-MM-DD string', () => {
      const result = getTomorrowDate();
      expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('should return a date one day ahead of today in Shanghai timezone', () => {
      const today = formatLocalDate(new Date());
      const tomorrow = getTomorrowDate();

      const todayMs = new Date(today).getTime();
      const tomorrowMs = new Date(tomorrow).getTime();

      expect(tomorrowMs - todayMs).toBe(24 * 60 * 60 * 1000);
    });
  });
});
