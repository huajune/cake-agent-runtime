import {
  candidateCovers,
  avoidsUnavailable,
  longestAvailableSpan,
} from '@resolution/schedule/time';
import type { ScheduleWindow } from '@resolution/schedule/types';

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

  it.each<{
    name: string;
    available: ScheduleWindow;
    unavailable?: ScheduleWindow;
    expected: number;
  }>([
    { name: '次日凌晨交集', available: { start: '00:00', end: '06:00' }, expected: 360 },
    { name: '当日晚间交集', available: { start: '21:00', end: '23:00' }, expected: 60 },
    { name: '结束端点相接', available: { start: '07:00', end: '08:00' }, expected: 0 },
    {
      name: '凌晨不可用区间切断连续时长',
      available: { start: '00:00', end: '06:00' },
      unavailable: { start: '02:00', end: '03:00' },
      expected: 180,
    },
    {
      name: '跨日不可用区间仍排除凌晨部分',
      available: { start: '00:00', end: '06:00' },
      unavailable: { start: '23:00', end: '02:00', endDayOffset: 1 },
      expected: 240,
    },
    {
      name: '两侧均跨日时不拼接不同日交集',
      available: { start: '23:00', end: '06:00', endDayOffset: 1 },
      expected: 420,
    },
  ])('跨日灵活窗口：$name', ({ available, unavailable, expected }) => {
    expect(
      longestAvailableSpan({ startMinute: 1320, endMinute: 1860 }, available, unavailable),
    ).toBe(expected);
  });

  it('当日凌晨灵活窗口可对齐到候选人的跨日窗口', () => {
    expect(
      longestAvailableSpan(
        { startMinute: 0, endMinute: 360 },
        { start: '22:00', end: '06:00', endDayOffset: 1 },
      ),
    ).toBe(360);
  });
});
