import { WorkTimeContractError } from '@sponge/work-time.types';
import { avoidsUnavailable, candidateCovers } from './time';
import {
  hasDailyScheduleConstraint,
  type CandidateScheduleConstraint,
  type JobSchedule,
  type ScheduleMatchResult,
  type ShiftTag,
  type TimeRange,
} from './types';

/**
 * 日内班次匹配。
 * - 标签粗筛按岗位标签并集：排除标签始终生效；只有可上班时段（availableWindow）优先于正向标签，
 *   不可用时段与时长只作额外排除，不替代正向标签。
 * - 固定排班须全部班次满足；组合排班须同一档同时满足正向标签、时间与时长；
 *   灵活排班的排班区间须整段满足时间条件，每班时长按门店安排的时长比较。
 * - 每个岗位都有班次数据：存在日内条件却拿不到班次时抛契约错误，不产出 unknown。
 */
export function matchDailySchedule(
  schedule: JobSchedule | null,
  conditions: CandidateScheduleConstraint = {},
): ScheduleMatchResult {
  const timePriority = Boolean(conditions.availableWindow);
  const includeTags = timePriority ? [] : (conditions.includeAnyTags ?? []);
  const excludeTags = conditions.excludeTags ?? [];
  const constrained = hasDailyScheduleConstraint(conditions);
  const mode: ScheduleMatchResult['mode'] = !constrained
    ? 'none'
    : !timePriority && (includeTags.length > 0 || excludeTags.length > 0)
      ? 'tag'
      : 'time';
  const result = (
    status: ScheduleMatchResult['status'],
    reason: string | null = null,
    matchedSlotIndexes: number[] = [],
  ): ScheduleMatchResult => ({ status, mode, matchedSlotIndexes, reason });
  if (!constrained) return result('matched');
  // 查岗在有班次条件时强制取回 workTime；缺少班次数据属于海绵契约错误，不能当作待确认或不匹配。
  if (!schedule) throw new WorkTimeContractError('已有班次条件但岗位缺少班次数据');

  const hasAny = (tags: readonly ShiftTag[], wanted: readonly ShiftTag[]) =>
    wanted.some((tag) => tags.includes(tag));
  if (hasAny(schedule.tags, excludeTags))
    return result('unmatched', '岗位包含候选人排除的班次标签');
  if (includeTags.length > 0 && !hasAny(schedule.tags, includeTags))
    return result('unmatched', '岗位没有候选人要求的班次标签');

  const fitsTime = (range: TimeRange) =>
    candidateCovers(range, conditions.availableWindow) &&
    avoidsUnavailable(range, conditions.unavailableWindow);
  const fitsDuration = (hours: number) =>
    (conditions.minShiftHours == null || hours >= conditions.minShiftHours) &&
    (conditions.maxShiftHours == null || hours <= conditions.maxShiftHours);

  if (schedule.arrangementType === '灵活排班') {
    if (!fitsTime(schedule.window))
      return result(
        'unmatched',
        '灵活排班须接受整个排班区间，候选人可上班时段未完整覆盖或与不可用时段重叠',
      );
    if (!fitsDuration(schedule.minimumMinutes / 60))
      return result('unmatched', '灵活排班每班时长不符合候选人时长要求');
    return result('matched');
  }

  const fixed = schedule.arrangementType === '固定排班';
  const matched = schedule.slots
    .filter(
      (slot) =>
        // 固定排班全部必选，正向标签已按岗位并集判定；组合排班须由同一可选档命中。
        (fixed || includeTags.length === 0 || hasAny(slot.tags, includeTags)) &&
        fitsTime(slot) &&
        fitsDuration((slot.endMinute - slot.startMinute) / 60),
    )
    .map((slot) => slot.index);
  const fits = fixed ? matched.length === schedule.slots.length : matched.length > 0;
  if (fits) return result('matched', null, matched);
  return result(
    'unmatched',
    fixed
      ? '固定排班要求完整接受全部班次，部分班次不符合时间或时长要求'
      : includeTags.length > 0
        ? '组合排班中没有一档同时符合要求的班次标签和时间、时长条件'
        : '组合排班中没有一档完整符合时间和时长要求',
    matched,
  );
}
