import {
  candidateCovers,
  avoidsUnavailable,
  longestAvailableSpan,
} from '@resolution/schedule/time';

describe('跨日时间区间', () => {
  it('凌晨班次可以对齐到候选人的次日窗口，但不能越过其结束边界', () => {
    const window = { start: '22:00', end: '06:00', endDayOffset: 1 as const };
    expect(candidateCovers({ startMinute: 0, endMinute: 360 }, window)).toBe(true);
    expect(candidateCovers({ startMinute: 0, endMinute: 361 }, window)).toBe(false);
  });

  it('跨日班次仍检查次日重复的不可用时间，端点相接可接受', () => {
    const slot = { startMinute: 1320, endMinute: 1800 };
    expect(avoidsUnavailable(slot, { start: '06:00', end: '08:00' })).toBe(true);
    expect(avoidsUnavailable(slot, { start: '05:59', end: '08:00' })).toBe(false);
  });

  it('灵活窗口内的碎片时间不能相加充当连续工时', () => {
    expect(
      longestAvailableSpan(
        { startMinute: 300, endMinute: 1380 },
        { start: '15:00', end: '21:00' },
        { start: '17:00', end: '19:00' },
      ),
    ).toBe(120);
  });
});
