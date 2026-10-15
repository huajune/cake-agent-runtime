import {
  canonicalizeScheduleConstraint,
  effectiveScheduleKey,
} from '@resolution/schedule/equivalence';

describe('班次条件有效等价', () => {
  it.each([
    { availableWindow: null },
    { excludeTags: [] },
    { onlyWeekends: false },
    { preferFlexibleSchedule: false },
    { minShiftHours: null, maxShiftHours: null, unavailableWindow: null },
  ])('空值与未保存等价：%j', (value) => {
    expect(canonicalizeScheduleConstraint(value)).toBeNull();
    expect(effectiveScheduleKey(value)).toBe(effectiveScheduleKey(null));
  });

  it('标签去重排序、endDayOffset:0 与省略等价', () => {
    expect(
      effectiveScheduleKey({
        includeAnyTags: ['morning', 'early', 'early'],
        availableWindow: { start: '18:00', endDayOffset: 0 },
      }),
    ).toBe(
      effectiveScheduleKey({
        includeAnyTags: ['early', 'morning'],
        availableWindow: { start: '18:00' },
      }),
    );
  });

  it('真实变化与旧标记待确认状态都会改变比较键', () => {
    expect(effectiveScheduleKey({ includeAnyTags: ['evening'] })).not.toBe(
      effectiveScheduleKey({ includeAnyTags: ['night'] }),
    );
    expect(effectiveScheduleKey({ onlyEvenings: true })).not.toBe(effectiveScheduleKey(null));
  });
});
