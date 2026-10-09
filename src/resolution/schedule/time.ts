import type { ScheduleWindow, TimeRange } from './types';

export const MINUTES_PER_DAY = 1440;

/** 调用方先验证钟点格式；不对非法钟点补值或截断。 */
export function clockToMinutes(clock: string): number {
  const [hours, minutes] = clock.split(':').map(Number);
  return hours * 60 + minutes;
}

export function minutesToClock(minutes: number): string {
  const value = minutes % MINUTES_PER_DAY;
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

export function overlapMinutes(a: TimeRange, b: TimeRange): number {
  return Math.max(0, Math.min(a.endMinute, b.endMinute) - Math.max(a.startMinute, b.startMinute));
}

export function windowToRange(window: ScheduleWindow): TimeRange {
  return {
    startMinute: window.start === undefined ? -Infinity : clockToMinutes(window.start),
    endMinute:
      window.end === undefined
        ? Infinity
        : clockToMinutes(window.end) + (window.endDayOffset ?? 0) * MINUTES_PER_DAY,
  };
}

export function shiftRange(range: TimeRange, days: number): TimeRange {
  return {
    startMinute: range.startMinute + days * MINUTES_PER_DAY,
    endMinute: range.endMinute + days * MINUTES_PER_DAY,
  };
}

/** 每日重复的不可用窗口覆盖班次开始日及相邻日，不能只检查跨日之前的那一段。 */
export function blockedRanges(window: ScheduleWindow): TimeRange[] {
  const range = windowToRange(window);
  const bounded = {
    startMinute: Math.max(0, range.startMinute),
    endMinute: Math.min(range.endMinute, window.endDayOffset ? 2880 : 1440),
  };
  return [-1, 0, 1].map((day) => shiftRange(bounded, day));
}

export function candidateCovers(range: TimeRange, available?: ScheduleWindow | null): boolean {
  if (!available) return true;
  const window = windowToRange(available);
  const offsets = available.endDayOffset === 1 ? [0, 1] : [0];
  return offsets.some((day) => {
    const aligned = shiftRange(range, day);
    return aligned.startMinute >= window.startMinute && aligned.endMinute <= window.endMinute;
  });
}

export function avoidsUnavailable(range: TimeRange, unavailable?: ScheduleWindow | null): boolean {
  return (
    !unavailable ||
    blockedRanges(unavailable).every((blocked) => overlapMinutes(range, blocked) === 0)
  );
}

/** 求窗口内可连续出勤的最长时段；中间不可用的时段不能拼接累计。 */
export function longestAvailableSpan(
  range: TimeRange,
  available?: ScheduleWindow | null,
  unavailable?: ScheduleWindow | null,
): number {
  const allowed = available
    ? windowToRange(available)
    : { startMinute: -Infinity, endMinute: Infinity };
  const offsets = available?.endDayOffset === 1 ? [0, 1] : [0];
  return Math.max(
    0,
    ...offsets.map((day) => {
      const aligned = shiftRange(range, day);
      let parts: TimeRange[] = [
        {
          startMinute: Math.max(aligned.startMinute, allowed.startMinute),
          endMinute: Math.min(aligned.endMinute, allowed.endMinute),
        },
      ];
      for (const blocked of unavailable ? blockedRanges(unavailable) : []) {
        parts = parts.flatMap((part) =>
          overlapMinutes(part, blocked) === 0
            ? [part]
            : [
                {
                  startMinute: part.startMinute,
                  endMinute: Math.min(part.endMinute, blocked.startMinute),
                },
                {
                  startMinute: Math.max(part.startMinute, blocked.endMinute),
                  endMinute: part.endMinute,
                },
              ].filter((piece) => piece.endMinute > piece.startMinute),
        );
      }
      return Math.max(0, ...parts.map((part) => part.endMinute - part.startMinute));
    }),
  );
}
