import { candidateCovers, avoidsUnavailable } from '@resolution/schedule/time';
import type { ScheduleWindow } from '@resolution/schedule/types';

describe('跨日时间区间', () => {
  it('单侧结束边界按夜班结束日判定，不误放行白天结束的班次', () => {
    const window = { end: '07:00' };
    expect(candidateCovers({ startMinute: 1320, endMinute: 1560 }, window)).toBe(true);
    expect(candidateCovers({ startMinute: 1320, endMinute: 1440 }, window)).toBe(true);
    expect(candidateCovers({ startMinute: 1320, endMinute: 1860 }, window)).toBe(true);
    expect(candidateCovers({ startMinute: 1320, endMinute: 1861 }, window)).toBe(false);
    expect(candidateCovers({ startMinute: 540, endMinute: 1020 }, window)).toBe(false);
    expect(
      candidateCovers({ startMinute: 1320, endMinute: 1560 }, { start: '00:00', end: '07:00' }),
    ).toBe(false);
  });

  it('单侧结束边界不放行开始当天已越过上限的零点或跨夜班次', () => {
    // 16:00–24:00 / 18:00–次日02:00 / 17:00–次日00:30 / 07:00–24:00
    expect(candidateCovers({ startMinute: 960, endMinute: 1440 }, { end: '21:00' })).toBe(false);
    expect(candidateCovers({ startMinute: 1080, endMinute: 1560 }, { end: '22:00' })).toBe(false);
    expect(candidateCovers({ startMinute: 1020, endMinute: 1470 }, { end: '23:00' })).toBe(false);
    expect(candidateCovers({ startMinute: 420, endMinute: 1440 }, { end: '20:00' })).toBe(false);
    expect(candidateCovers({ startMinute: 1080, endMinute: 1560 }, { end: '24:00' })).toBe(false);
  });

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

  it.each<{ name: string; window: ScheduleWindow; covered: boolean }>([
    {
      name: '跨日可上班时段完整覆盖',
      window: { start: '22:00', end: '07:00', endDayOffset: 1 },
      covered: true,
    },
    { name: '只覆盖次日凌晨部分', window: { start: '00:00', end: '06:00' }, covered: false },
    { name: '只覆盖当日晚间部分', window: { start: '21:00', end: '23:00' }, covered: false },
  ])('跨日区间须整段被可上班时段覆盖：$name', ({ window, covered }) => {
    expect(candidateCovers({ startMinute: 1320, endMinute: 1860 }, window)).toBe(covered);
  });

  it.each<{ name: string; unavailable: ScheduleWindow; avoids: boolean }>([
    { name: '凌晨不可用区间', unavailable: { start: '02:00', end: '03:00' }, avoids: false },
    {
      name: '跨日不可用区间',
      unavailable: { start: '23:00', end: '02:00', endDayOffset: 1 },
      avoids: false,
    },
    { name: '结束端点相接', unavailable: { start: '07:00', end: '08:00' }, avoids: true },
  ])('跨日区间检查次日重复的不可用时段：$name', ({ unavailable, avoids }) => {
    expect(avoidsUnavailable({ startMinute: 1320, endMinute: 1860 }, unavailable)).toBe(avoids);
  });
});
