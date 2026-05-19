import {
  formatShanghaiDate,
  formatShanghaiTime,
  normalizeRequestedDate,
  resolveDateFromWeekday,
  resolveMonthDayToNearestFutureDate,
  resolveWeeklyDateExpression,
  toDateString,
} from '@tools/duliday/precheck/date.util';

/**
 * 锚定 Shanghai 当地 2026-05-19（周二）10:00。
 * Shanghai 是 UTC+8 全年无 DST，固定偏移即可。
 */
const FIXED_NOW = new Date('2026-05-19T10:00:00+08:00');

describe('date.util', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(FIXED_NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  describe('toDateString', () => {
    it('formats valid year/month/day with zero-padding', () => {
      expect(toDateString(2026, 5, 1)).toBe('2026-05-01');
      expect(toDateString(2026, 12, 31)).toBe('2026-12-31');
    });

    it('returns null for invalid components', () => {
      expect(toDateString(2026, 0, 1)).toBeNull();
      expect(toDateString(2026, 13, 1)).toBeNull();
      expect(toDateString(2026, 5, 0)).toBeNull();
      expect(toDateString(2026, 5, 32)).toBeNull();
    });

    it('rejects logically impossible dates (Feb 30 / Apr 31)', () => {
      // Date constructor would roll over to a valid date — toDateString must reject
      expect(toDateString(2026, 2, 30)).toBeNull();
      expect(toDateString(2026, 4, 31)).toBeNull();
    });

    it('returns null for non-finite inputs', () => {
      expect(toDateString(Number.NaN, 5, 1)).toBeNull();
    });
  });

  describe('normalizeRequestedDate', () => {
    it('parses 今天 / today as Shanghai today', () => {
      expect(normalizeRequestedDate('今天').date).toBe('2026-05-19');
      expect(normalizeRequestedDate('today').date).toBe('2026-05-19');
    });

    it('parses 明天 / tomorrow', () => {
      expect(normalizeRequestedDate('明天').date).toBe('2026-05-20');
      expect(normalizeRequestedDate('tomorrow').date).toBe('2026-05-20');
    });

    it('parses 后天', () => {
      expect(normalizeRequestedDate('后天').date).toBe('2026-05-21');
    });

    it('parses 本周X / 下周X', () => {
      // 2026-05-19 周二 → 本周三 = 2026-05-20，下周一 = 2026-05-25
      expect(normalizeRequestedDate('本周三').date).toBe('2026-05-20');
      expect(normalizeRequestedDate('下周一').date).toBe('2026-05-25');
    });

    it('parses bare 周X — falls into next week if weekday already passed', () => {
      // 周一 < 周二（today）→ 跳到下周一
      expect(normalizeRequestedDate('周一').date).toBe('2026-05-25');
      // 周三 >= 周二（today）→ 本周三
      expect(normalizeRequestedDate('周三').date).toBe('2026-05-20');
    });

    it('parses "X月Y日" — picks nearest future occurrence', () => {
      expect(normalizeRequestedDate('6月1日').date).toBe('2026-06-01');
      // 5月1日 已过 → 跳到次年
      expect(normalizeRequestedDate('5月1日').date).toBe('2027-05-01');
    });

    it('parses full ISO and slash variants', () => {
      expect(normalizeRequestedDate('2026-06-15').date).toBe('2026-06-15');
      expect(normalizeRequestedDate('2026/06/15').date).toBe('2026-06-15');
    });

    it('returns date=null + error for unparseable input', () => {
      const result = normalizeRequestedDate('明儿个');
      expect(result.date).toBeNull();
      expect(result.error).toBeDefined();
    });

    it('returns nulls for empty/undefined input', () => {
      expect(normalizeRequestedDate(undefined)).toEqual({ date: null, normalizedInput: null });
      expect(normalizeRequestedDate('').date).toBeNull();
    });

    it('rejects illegal "X月Y日" like 2月30日', () => {
      const result = normalizeRequestedDate('2月30日');
      expect(result.date).toBeNull();
      expect(result.error).toBeDefined();
    });
  });

  describe('resolveWeeklyDateExpression', () => {
    const today = '2026-05-19'; // 周二

    it('handles 本周/这周/本星期/这星期 prefix', () => {
      expect(resolveWeeklyDateExpression('本周三', today)).toBe('2026-05-20');
      expect(resolveWeeklyDateExpression('这周三', today)).toBe('2026-05-20');
      expect(resolveWeeklyDateExpression('本星期五', today)).toBe('2026-05-22');
    });

    it('handles 下周/下星期 prefix', () => {
      expect(resolveWeeklyDateExpression('下周一', today)).toBe('2026-05-25');
      expect(resolveWeeklyDateExpression('下星期日', today)).toBe('2026-05-31');
    });

    it('handles bare 周X and skips to next week when already past', () => {
      // today 是周二，"周一" 已过 → 下周一
      expect(resolveWeeklyDateExpression('周一', today)).toBe('2026-05-25');
    });

    it('accepts 1-7 numeric weekday tokens', () => {
      expect(resolveWeeklyDateExpression('本周3', today)).toBe('2026-05-20');
      expect(resolveWeeklyDateExpression('下周1', today)).toBe('2026-05-25');
    });

    it('returns null when expression does not match', () => {
      expect(resolveWeeklyDateExpression('明天', today)).toBeNull();
    });
  });

  describe('resolveDateFromWeekday', () => {
    const today = '2026-05-19'; // 周二

    it('handles weekday 1-7 with weekOffset', () => {
      expect(
        resolveDateFromWeekday(today, '一', { weekOffset: 0, keepPastInCurrentWeek: true }),
      ).toBe('2026-05-18');
      expect(
        resolveDateFromWeekday(today, '一', { weekOffset: 1, keepPastInCurrentWeek: true }),
      ).toBe('2026-05-25');
    });

    it('keepPastInCurrentWeek=false jumps to next week when target is past', () => {
      expect(
        resolveDateFromWeekday(today, '一', { weekOffset: 0, keepPastInCurrentWeek: false }),
      ).toBe('2026-05-25');
    });

    it('returns null for unknown weekday token', () => {
      expect(
        resolveDateFromWeekday(today, '九', { weekOffset: 0, keepPastInCurrentWeek: true }),
      ).toBeNull();
    });
  });

  describe('resolveMonthDayToNearestFutureDate', () => {
    const today = '2026-05-19';
    it('keeps month/day in current year when not yet past', () => {
      expect(resolveMonthDayToNearestFutureDate(6, 1, today)).toBe('2026-06-01');
    });
    it('jumps to next year when month/day already past', () => {
      expect(resolveMonthDayToNearestFutureDate(5, 1, today)).toBe('2027-05-01');
    });
    it('returns null for invalid month/day', () => {
      expect(resolveMonthDayToNearestFutureDate(13, 1, today)).toBeNull();
    });
  });

  describe('formatShanghaiDate / formatShanghaiTime', () => {
    it('formats now() to Shanghai YYYY-MM-DD / HH:mm', () => {
      expect(formatShanghaiDate(FIXED_NOW)).toBe('2026-05-19');
      expect(formatShanghaiTime(FIXED_NOW)).toBe('10:00');
    });
  });
});
