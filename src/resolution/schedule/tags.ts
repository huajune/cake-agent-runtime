import { MINUTES_PER_DAY, overlapMinutes } from './time';
import { SHIFT_TAGS, type ShiftTag, type TimeRange } from './types';

export const MIN_TAG_OVERLAP_MINUTES = 60;
const DAY_WINDOWS: Array<{ tag: ShiftTag; startMinute: number; endMinute: number }> = [
  { tag: 'early', startMinute: 240, endMinute: 480 },
  { tag: 'morning', startMinute: 480, endMinute: 660 },
  { tag: 'midday', startMinute: 660, endMinute: 840 },
  { tag: 'afternoon', startMinute: 840, endMinute: 1020 },
  { tag: 'evening', startMinute: 1020, endMinute: 1260 },
];

/**
 * 班次与排班区间共用的标签定义。日间标签只与开始当天的窗口比较：跨过次日零点后的凌晨部分
 * 只计夜班，不再打次日的早班等标签。夜班为开始于 21:00—次日04:00 或跨过次日零点；
 * 刚好 24:00 结束不算跨零点。
 */
export function buildShiftTags(range: TimeRange): ShiftTag[] {
  const tags = new Set<ShiftTag>();
  for (const window of DAY_WINDOWS) {
    if (overlapMinutes(range, window) >= MIN_TAG_OVERLAP_MINUTES) tags.add(window.tag);
  }
  if (range.startMinute >= 1260 || range.startMinute < 240 || range.endMinute > MINUTES_PER_DAY)
    tags.add('night');
  return SHIFT_TAGS.filter((tag) => tags.has(tag));
}
