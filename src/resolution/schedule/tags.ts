import { MINUTES_PER_DAY, overlapMinutes, shiftRange } from './time';
import { SHIFT_TAGS, type ShiftTag, type TimeRange } from './types';

export const MIN_TAG_OVERLAP_MINUTES = 60;
const DAY_WINDOWS: Array<{ tag: ShiftTag; startMinute: number; endMinute: number }> = [
  { tag: 'early', startMinute: 240, endMinute: 480 },
  { tag: 'morning', startMinute: 480, endMinute: 660 },
  { tag: 'midday', startMinute: 660, endMinute: 840 },
  { tag: 'afternoon', startMinute: 840, endMinute: 1020 },
  { tag: 'evening', startMinute: 1020, endMinute: 1260 },
];

export function buildShiftTags(range: TimeRange): ShiftTag[] {
  const tags = new Set<ShiftTag>();
  for (const window of DAY_WINDOWS) {
    if (
      [0, 1].some(
        (day) => overlapMinutes(range, shiftRange(window, day)) >= MIN_TAG_OVERLAP_MINUTES,
      )
    )
      tags.add(window.tag);
  }
  if (range.startMinute >= 1260 || range.startMinute < 240 || range.endMinute > MINUTES_PER_DAY)
    tags.add('night');
  return SHIFT_TAGS.filter((tag) => tags.has(tag));
}
