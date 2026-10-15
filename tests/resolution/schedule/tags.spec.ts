import { buildShiftTags } from '@resolution/schedule/tags';
import { clockToMinutes, MINUTES_PER_DAY } from '@resolution/schedule/time';
import type { ShiftTag } from '@resolution/schedule/types';

function tagsOf(start: string, end: string): ShiftTag[] {
  const startMinute = clockToMinutes(start);
  const endClock = clockToMinutes(end);
  return buildShiftTags({
    startMinute,
    endMinute: endClock + (endClock <= startMinute ? MINUTES_PER_DAY : 0),
  });
}

describe('班次标签阈值', () => {
  it('59分钟不打标，60分钟打标，同一班次可以多标签', () => {
    expect(buildShiftTags({ startMinute: 421, endMinute: 600 })).toEqual(['morning']);
    expect(buildShiftTags({ startMinute: 420, endMinute: 600 })).toEqual(['early', 'morning']);
  });
  it('21点起或跨过零点为夜班，不沿用60分钟阈值', () => {
    expect(buildShiftTags({ startMinute: 1260, endMinute: 1290 })).toEqual(['night']);
    expect(buildShiftTags({ startMinute: 1200, endMinute: 1450 })).toContain('night');
  });
  it('在时段内开始的班重叠满1小时打标，从前一时段延伸进来的须满2小时', () => {
    expect(tagsOf('09:00', '18:00')).toEqual(['morning', 'midday', 'afternoon']);
    expect(tagsOf('08:00', '18:30')).toEqual(['morning', 'midday', 'afternoon']);
    expect(tagsOf('10:00', '19:00')).toEqual(['morning', 'midday', 'afternoon', 'evening']);
    expect(tagsOf('11:00', '15:00')).toEqual(['midday']);
    expect(tagsOf('08:00', '12:00')).toEqual(['morning']);
    expect(tagsOf('20:00', '24:00')).toEqual(['evening']);
    expect(tagsOf('19:30', '23:00')).toEqual(['evening']);
    expect(tagsOf('16:00', '22:00')).toEqual(['afternoon', 'evening']);
  });
  it('刚好24:00结束不算跨零点，不打夜班标签', () => {
    expect(buildShiftTags({ startMinute: 960, endMinute: 1440 })).toEqual(['afternoon', 'evening']);
  });
});

describe('跨零点班次只按开始当天打日间标签', () => {
  it.each<[string, string, ShiftTag[]]>([
    ['22:00', '07:00', ['night']],
    ['23:00', '09:00', ['night']],
    ['18:00', '02:00', ['evening', 'night']],
    ['02:00', '10:00', ['early', 'morning', 'night']],
  ])('%s-%s', (start, end, expected) => {
    expect(tagsOf(start, end)).toEqual(expected);
  });
});

describe('运营定义示例', () => {
  it.each<[string, string, ShiftTag[]]>([
    ['05:00', '14:00', ['early', 'morning', 'midday']],
    ['06:00', '10:00', ['early', 'morning']],
    // 07:00-15:00 只延伸进下午班 1 小时，按统一规则不打下午班（运营示例只要求早班）。
    ['07:00', '15:00', ['early', 'morning', 'midday']],
    ['17:00', '23:00', ['evening']],
    ['18:00', '22:00', ['evening']],
    ['16:00', '00:00', ['afternoon', 'evening']],
    ['22:00', '07:00', ['night']],
    ['21:30', '00:30', ['night']],
    ['18:00', '02:00', ['evening', 'night']],
    ['23:00', '01:00', ['night']],
  ])('%s-%s', (start, end, expected) => {
    expect(tagsOf(start, end)).toEqual(expected);
  });
});
