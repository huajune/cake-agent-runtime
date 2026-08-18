import {
  CHINESE_CARDINAL,
  CHINESE_WEEKDAY_ISO,
  WEEKDAY_LABELS_LONG,
  WEEKDAY_LABELS_SHORT,
  isoWeekdayToJsDay,
} from '@infra/utils/chinese-numeral.util';

describe('chinese-numeral.util', () => {
  it('maps cardinals 零到十，且「两」与「二」同值（口语「两点」）', () => {
    expect(CHINESE_CARDINAL['零']).toBe(0);
    expect(CHINESE_CARDINAL['十']).toBe(10);
    expect(CHINESE_CARDINAL['两']).toBe(CHINESE_CARDINAL['二']);
  });

  it('maps weekdays to ISO indices，周日同时收「日」「天」', () => {
    expect(CHINESE_WEEKDAY_ISO['一']).toBe(1);
    expect(CHINESE_WEEKDAY_ISO['六']).toBe(6);
    expect(CHINESE_WEEKDAY_ISO['日']).toBe(7);
    expect(CHINESE_WEEKDAY_ISO['天']).toBe(7);
  });

  it('isoWeekdayToJsDay 把 ISO 周日(7) 折成 Date#getDay() 的 0，其余原样', () => {
    expect(isoWeekdayToJsDay(7)).toBe(0);
    expect(isoWeekdayToJsDay(1)).toBe(1);
    expect(isoWeekdayToJsDay(6)).toBe(6);
  });

  it('weekday label tables are indexed by Date#getDay()（下标错位会让话术说错星期）', () => {
    // 2026-08-16 是周日，getDay() = 0。
    const sunday = new Date('2026-08-16T12:00:00+08:00');
    expect(WEEKDAY_LABELS_SHORT[sunday.getDay()]).toBe('周日');
    expect(WEEKDAY_LABELS_LONG[sunday.getDay()]).toBe('星期日');
    expect(WEEKDAY_LABELS_SHORT).toHaveLength(7);
    expect(WEEKDAY_LABELS_LONG).toHaveLength(7);
    expect(WEEKDAY_LABELS_SHORT[isoWeekdayToJsDay(CHINESE_WEEKDAY_ISO['三'])]).toBe('周三');
  });

  it('exposes frozen tables（词表是唯一真相源，禁止运行时改写）', () => {
    expect(Object.isFrozen(CHINESE_CARDINAL)).toBe(true);
    expect(Object.isFrozen(CHINESE_WEEKDAY_ISO)).toBe(true);
    expect(Object.isFrozen(WEEKDAY_LABELS_SHORT)).toBe(true);
  });
});
