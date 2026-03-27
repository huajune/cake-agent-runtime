import { formatLocalDate, formatLocalDateTime, getTomorrowDate } from '@infra/utils/date.util';

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
