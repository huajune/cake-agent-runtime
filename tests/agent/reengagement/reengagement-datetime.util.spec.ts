import {
  formatRelativeShanghaiDate,
  formatShanghaiClock,
  formatShanghaiDate,
  formatShanghaiDateWithWeekday,
  formatShanghaiTime,
  shanghaiDayNumber,
} from '@agent/reengagement/reengagement-datetime.util';

// 生产容器时区是 UTC：这些函数必须自己锁 Asia/Shanghai，否则复聊话术会把
// 上海凌晨的面试说成"昨天"。用跨零点的 UTC 时刻做判据。
const AUG_13_1430_SH = Date.parse('2026-08-13T14:30:00+08:00');
/** 上海 8/14 00:30 == UTC 8/13 16:30：按 UTC 算会退回 8/13。 */
const AUG_14_0030_SH = Date.parse('2026-08-13T16:30:00Z');

describe('reengagement datetime（上海时区展示口径）', () => {
  it('formatShanghaiTime renders zh-CN date + 24h clock', () => {
    expect(formatShanghaiTime(AUG_13_1430_SH)).toBe('2026/8/13 14:30');
  });

  it('formatShanghaiClock renders 24h time only', () => {
    expect(formatShanghaiClock(AUG_13_1430_SH)).toBe('14:30');
  });

  it('formatShanghaiDate renders the Shanghai calendar day, not the UTC one', () => {
    expect(formatShanghaiDate(AUG_14_0030_SH)).toBe('2026/8/14');
  });

  it('shanghaiDayNumber 按上海日界切分（跨零点必须进位）', () => {
    expect(shanghaiDayNumber(AUG_14_0030_SH)).toBe(shanghaiDayNumber(AUG_13_1430_SH) + 1);
  });

  describe('formatRelativeShanghaiDate', () => {
    it('says 今天 for the same Shanghai day', () => {
      const text = formatRelativeShanghaiDate(AUG_13_1430_SH, Date.parse('2026-08-13T09:00:00+08:00'));
      expect(text).toContain('今天');
      expect(text).toContain('不得说“明天”');
    });

    it('says 明天 for the next Shanghai day', () => {
      const text = formatRelativeShanghaiDate(AUG_14_0030_SH, AUG_13_1430_SH);
      expect(text).toContain('明天');
    });

    it('falls back to an explicit date beyond tomorrow（禁止说今天/明天）', () => {
      const text = formatRelativeShanghaiDate(
        Date.parse('2026-08-16T10:00:00+08:00'),
        AUG_13_1430_SH,
      );
      expect(text).toContain('2026/8/16');
      expect(text).toContain('不要说“今天”或“明天”');
    });

    it('treats a past day as an explicit date, never 今天', () => {
      const text = formatRelativeShanghaiDate(
        Date.parse('2026-08-11T10:00:00+08:00'),
        AUG_13_1430_SH,
      );
      expect(text).toContain('2026/8/11');
      expect(text).not.toContain('今天（');
    });
  });

  it('formatShanghaiDateWithWeekday offsets by whole days', () => {
    const today = formatShanghaiDateWithWeekday(AUG_13_1430_SH, 0);
    const tomorrow = formatShanghaiDateWithWeekday(AUG_13_1430_SH, 1);
    expect(today).not.toBe(tomorrow);
    expect(today).toMatch(/周|星期/u);
  });
});
