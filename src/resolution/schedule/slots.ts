import type { TimeRange } from './types';

/**
 * 运营兜底（2026-10-14）：单个班次超过 12 小时视为把营业时间填成了班次，按灵活排班处理，
 * 在该时段内排 6-8 小时；海绵数据修正为灵活排班后不再触发。
 */
export const LONG_SLOT_THRESHOLD_MINUTES = 720;
export const LONG_SLOT_MIN_MINUTES = 360;
export const LONG_SLOT_MAX_MINUTES = 480;

export interface LongSlotArrangement {
  minMinutes: number;
  maxMinutes: number;
}

/** 超过 12 小时的班次返回按灵活排班安排的每班时长范围，其余返回 undefined。 */
export function longSlotArrangement(range: TimeRange): LongSlotArrangement | undefined {
  return range.endMinute - range.startMinute > LONG_SLOT_THRESHOLD_MINUTES
    ? { minMinutes: LONG_SLOT_MIN_MINUTES, maxMinutes: LONG_SLOT_MAX_MINUTES }
    : undefined;
}

/**
 * 固定排班多个班次之间的关系（运营 2026-10-14 口径）：
 * - separate_days：班次互相重叠或合计超过 12 小时，认定不在同一天上，候选人须全部都能接受；
 * - unclear：不重叠且合计不超过 12 小时，无法判断是否同一天都要上，相关追问与报名转人工；
 * - single：只有一个班次。
 * 按海绵原始班次时间判断，不受超长班次兜底影响。
 */
export type FixedSlotsRelation = 'single' | 'separate_days' | 'unclear';

export function fixedSlotsRelation(slots: readonly TimeRange[]): FixedSlotsRelation {
  if (slots.length <= 1) return 'single';
  const overlap = slots.some((a, i) =>
    slots
      .slice(i + 1)
      .some((b) => Math.max(a.startMinute, b.startMinute) < Math.min(a.endMinute, b.endMinute)),
  );
  const total = slots.reduce((sum, slot) => sum + slot.endMinute - slot.startMinute, 0);
  return overlap || total > LONG_SLOT_THRESHOLD_MINUTES ? 'separate_days' : 'unclear';
}
