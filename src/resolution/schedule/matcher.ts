import { avoidsUnavailable, candidateCovers, longestAvailableSpan, MINUTES_PER_DAY } from './time';
import {
  hasDailyScheduleConstraint,
  type CandidateScheduleConstraint,
  type JobSchedule,
  type ScheduleMatchResult,
} from './types';

export function matchDailySchedule(
  schedule: JobSchedule | null,
  conditions: CandidateScheduleConstraint = {},
): ScheduleMatchResult {
  const timed = Boolean(conditions.availableWindow || conditions.unavailableWindow);
  const tagged = Boolean(conditions.includeAnyTags?.length || conditions.excludeTags?.length);
  const mode: ScheduleMatchResult['mode'] = timed ? 'time' : tagged ? 'tag' : 'none';
  const result = (
    status: ScheduleMatchResult['status'],
    reason: string | null = null,
    matchedSlotIndexes: number[] = [],
  ): ScheduleMatchResult => ({ status, mode, matchedSlotIndexes, reason });
  if (!hasDailyScheduleConstraint(conditions)) return result('matched');
  if (!schedule) return result('unknown', '尚未取得岗位班次事实');
  if (timed && conditions.excludeTags?.length)
    return result('unknown', '具体时段与独立排除标签并存，需要明确本次有效条件');
  if (schedule.arrangementType === '灵活排班') {
    const span = longestAvailableSpan(
      schedule.window,
      conditions.availableWindow,
      conditions.unavailableWindow,
    );
    if (
      span < Math.max(schedule.minimumMinutes, (conditions.minShiftHours ?? 0) * 60) ||
      (conditions.maxShiftHours != null && schedule.minimumMinutes > conditions.maxShiftHours * 60)
    )
      return result('unmatched', '连续可出勤时段不足岗位最低工时或候选人时长要求');
    return result('unknown', '灵活排班仅提供窗口及最低工时，尚未明确实际可安排班次');
  }
  if (!timed && tagged) {
    if (
      [...(conditions.includeAnyTags ?? []), ...(conditions.excludeTags ?? [])].includes('night') &&
      schedule.slots.some(
        (slot) =>
          slot.endMinute === MINUTES_PER_DAY && slot.startMinute < 1260 && slot.startMinute >= 240,
      )
    )
      return result('unknown', '刚好结束于零点的夜班标签含义需要确认');
    if (conditions.excludeTags?.some((tag) => schedule.tags.includes(tag)))
      return result('unmatched', '岗位包含候选人排除的班次标签');
    if (
      conditions.includeAnyTags?.length &&
      !conditions.includeAnyTags.some((tag) => schedule.tags.includes(tag))
    )
      return result('unmatched', '岗位没有候选人要求的班次标签');
  }
  const matched = schedule.slots
    .filter((slot) => {
      const duration = (slot.endMinute - slot.startMinute) / 60;
      return (
        candidateCovers(slot, conditions.availableWindow) &&
        avoidsUnavailable(slot, conditions.unavailableWindow) &&
        (conditions.minShiftHours == null || duration >= conditions.minShiftHours) &&
        (conditions.maxShiftHours == null || duration <= conditions.maxShiftHours)
      );
    })
    .map((slot) => slot.index);
  const fits =
    schedule.arrangementType === '固定排班'
      ? matched.length === schedule.slots.length
      : matched.length > 0;
  return fits
    ? result('matched', null, matched)
    : result(
        'unmatched',
        schedule.arrangementType === '固定排班'
          ? '固定排班要求完整接受全部班次，部分班次不符合时间或时长要求'
          : '组合排班中没有一档完整符合时间和时长要求',
        matched,
      );
}
