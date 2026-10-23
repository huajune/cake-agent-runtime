// business-rules: SH-01, SH-02, SH-03, SH-04, SH-05
import { WorkTimeContractError } from '@sponge/work-time.types';
import { buildShiftTags } from './tags';
import {
  avoidsUnavailable,
  candidateCovers,
  minutesToClock,
  MINUTES_PER_DAY,
  shiftRange,
} from './time';
import {
  hasDailyScheduleConstraint,
  type CandidateScheduleConstraint,
  SHIFT_TAGS,
  type JobSchedule,
  type ScheduleMatchResult,
  type ShiftSlot,
  type ShiftTag,
  type TimeRange,
} from './types';

/**
 * 日内班次匹配。
 * - 标签粗筛按岗位标签并集（灵活排班按排到的整班判定；组合排班的排除标签按档判定，任选一档不命中即可）：
 *   排除标签始终生效；只有可上班时段
 *   （availableWindow）优先于正向标签，不可用时段与时长只作额外排除，不替代正向标签。
 * - 固定排班须全部班次满足；组合排班须同一档同时满足正向标签、时间与时长；
 *   灵活排班由门店按候选人可上班时间在排班区间内安排一个完整班次：区间内能排出一段满足时间、
 *   标签与时长条件的完整班次即匹配。固定／组合中超过 12 小时的班次按灵活排班兜底，在该时段内
 *   排 6-8 小时（slots.ts），其标签同样按排出的整班判定，不参与岗位标签并集的排除。
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
  const fitsTime = (range: TimeRange) =>
    candidateCovers(range, conditions.availableWindow) &&
    avoidsUnavailable(range, conditions.unavailableWindow);
  const fitsDuration = (hours: number) =>
    (conditions.minShiftHours == null || hours >= conditions.minShiftHours) &&
    (conditions.maxShiftHours == null || hours <= conditions.maxShiftHours);
  const nightWanted = conditions.includeAnyTags?.includes('night') ?? false;
  // 在一个时段内试排完整班次：时段、排除标签按排出的整班判定，正向标签仅在要求时判定；
  // 不要求时（固定排班的超长档）仍优先用命中正向标签的整班作示例。
  const arrange = (
    window: TimeRange,
    minutes: number,
    wanted: readonly ShiftTag[],
    preferred: readonly ShiftTag[] = wanted,
  ) =>
    arrangeShift(window, minutes, preferred, nightWanted, (shift, tags) => {
      if (!fitsTime(shift) || hasAny(tags, excludeTags)) return false;
      return wanted.length === 0 || hasAny(tags, wanted);
    });

  if (schedule.arrangementType === '灵活排班') {
    if (!fitsDuration(schedule.minimumMinutes / 60))
      return result('unmatched', '灵活排班每班时长不符合候选人时长要求');
    const shift = arrange(schedule.window, schedule.minimumMinutes, includeTags);
    if (!shift)
      return result('unmatched', '灵活排班区间内排不出一个符合候选人时间或班次要求的完整班次');
    return result('matched', `可安排 ${rangeText(shift)} 等时段`);
  }

  // 超过 12 小时的班次按灵活排班兜底（slots.ts），在该时段内排 6-8 小时：先试满 8 小时，
  // 排不满再按半小时往短排，最短 6 小时；时长与候选人每班时长要求取交集。其余班次按原班次判定。
  const regular = schedule.slots.filter((slot) => !slot.arranged);
  const regularTags = regular.flatMap((slot) => slot.tags);
  const fixed = schedule.arrangementType === '固定排班';
  // 排除标签：固定排班每档都要上，任一档命中即排除；组合排班任选一档，只排除命中的那几档，
  // 档档都命中时才整岗排除。
  const excludedSlot = (slot: ShiftSlot) => !slot.arranged && hasAny(slot.tags, excludeTags);
  if (fixed ? regular.some(excludedSlot) : schedule.slots.every(excludedSlot))
    return result('unmatched', '岗位包含候选人排除的班次标签');
  const examples: string[] = [];
  const arrangeLong = (
    slot: ShiftSlot,
    wanted: readonly ShiftTag[],
    preferred: readonly ShiftTag[] = wanted,
  ) => {
    const { minMinutes, maxMinutes } = slot.arranged!;
    for (let minutes = maxMinutes; minutes >= minMinutes; minutes -= 30) {
      if (!fitsDuration(minutes / 60)) continue;
      const shift = arrange(slot, minutes, wanted, preferred);
      if (shift) return shift;
    }
    return null;
  };
  const slotFits = (slot: ShiftSlot, wanted: readonly ShiftTag[]) => {
    if (!slot.arranged)
      return (
        !excludedSlot(slot) &&
        (wanted.length === 0 || hasAny(slot.tags, wanted)) &&
        fitsTime(slot) &&
        fitsDuration((slot.endMinute - slot.startMinute) / 60)
      );
    const shift = arrangeLong(slot, wanted, includeTags);
    if (shift) {
      const { minMinutes, maxMinutes } = slot.arranged;
      examples.push(
        `${rangeText(slot)} 时段内可安排 ${rangeText(shift)} 等 ${minMinutes / 60}-${maxMinutes / 60} 小时班次`,
      );
    }
    return Boolean(shift);
  };
  if (
    includeTags.length > 0 &&
    !hasAny(regularTags, includeTags) &&
    !schedule.slots.some((slot) => slot.arranged && arrangeLong(slot, includeTags))
  )
    return result('unmatched', '岗位没有候选人要求的班次标签');

  // 固定排班全部必选，正向标签已按岗位整体判定；组合排班须由同一可选档命中。
  const matched = schedule.slots
    .filter((slot) => slotFits(slot, fixed ? [] : includeTags))
    .map((slot) => slot.index);
  const fits = fixed ? matched.length === schedule.slots.length : matched.length > 0;
  if (fits) return result('matched', examples.length > 0 ? examples.join('；') : null, matched);
  return result(
    'unmatched',
    fixed
      ? '固定排班要求完整接受全部班次，部分班次不符合时间或时长要求'
      : excludeTags.length > 0
        ? '组合排班中没有一档同时避开候选人排除的班次并符合其他条件'
        : includeTags.length > 0
          ? '组合排班中没有一档同时符合要求的班次标签和时间、时长条件'
          : '组合排班中没有一档完整符合时间和时长要求',
    matched,
  );
}

function rangeText({ startMinute, endMinute }: TimeRange): string {
  const end = `${endMinute >= MINUTES_PER_DAY ? '次日' : ''}${minutesToClock(endMinute)}`;
  return `${minutesToClock(startMinute)}-${end}`;
}

/**
 * 在时段内试排一个完整的每班时长，返回满足 fits 的整班；灵活排班与超过 12 小时的班次兜底共用。
 * 时段按当天钟点对齐比较（过零点后才开始的整班属于次日）；标签按时段坐标计算，与区间标签一致：
 * 过零点后的部分只计夜班。示例取舍：未要夜班时夜班整班排在任何非夜班整班之后；有正向标签时
 * 再取多余班次类型最少的整班（同分取最早）。先从首个整点/半点起按半点试排，排不出再逐分钟兜底。
 */
function arrangeShift(
  window: TimeRange,
  minutes: number,
  wanted: readonly ShiftTag[],
  nightWanted: boolean,
  fits: (shift: TimeRange, tags: readonly ShiftTag[]) => boolean,
): TimeRange | null {
  const search = (step: number) => {
    let best: { shift: TimeRange; rank: number } | null = null;
    for (
      let start = Math.ceil(window.startMinute / step) * step;
      start + minutes <= window.endMinute;
      start += step
    ) {
      const raw = { startMinute: start, endMinute: start + minutes };
      const shift = start >= MINUTES_PER_DAY ? shiftRange(raw, -1) : raw;
      const tags = buildShiftTags(raw);
      if (!fits(shift, tags)) continue;
      const rank =
        (wanted.length > 0 ? tags.filter((tag) => !wanted.includes(tag)).length : 0) +
        (!nightWanted && tags.includes('night') ? SHIFT_TAGS.length : 0);
      if (!best || rank < best.rank) best = { shift, rank };
      if (rank === 0) break;
    }
    return best?.shift ?? null;
  };
  return search(30) ?? search(1);
}
