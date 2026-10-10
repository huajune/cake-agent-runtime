import { z } from 'zod';

export const SHIFT_TAGS = ['early', 'morning', 'midday', 'afternoon', 'evening', 'night'] as const;
export type ShiftTag = (typeof SHIFT_TAGS)[number];
export const SHIFT_TAG_LABELS: Record<ShiftTag, string> = {
  early: '早班',
  morning: '上午班',
  midday: '中班',
  afternoon: '下午班',
  evening: '晚班',
  night: '夜班',
};

export const ClockTimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const EndClockTimeSchema = z.union([ClockTimeSchema, z.literal('24:00')]);

export const ScheduleWindowSchema = z
  .object({
    start: ClockTimeSchema.optional(),
    end: EndClockTimeSchema.optional(),
    endDayOffset: z.union([z.literal(0), z.literal(1)]).optional(),
  })
  .strict()
  .superRefine((window, ctx) => {
    if (window.start === undefined && window.end === undefined) {
      ctx.addIssue({ code: 'custom', message: '至少提供一个时间边界' });
    }
    if (window.endDayOffset === 1 && (!window.start || !window.end || window.end === '24:00')) {
      ctx.addIssue({
        code: 'custom',
        message: '次日结束须同时提供起止钟点，结束不能重复使用24:00',
      });
    }
    if (window.start && window.end && window.endDayOffset === 1 && window.end > window.start) {
      ctx.addIssue({ code: 'custom', message: '每日可出勤区间不能超过24小时' });
    }
    if (window.start && window.end && !window.endDayOffset && window.end <= window.start) {
      ctx.addIssue({ code: 'custom', message: '跨日区间须明确endDayOffset=1，起止相同须先澄清' });
    }
  });

/** 可复用的字段契约；不补默认值，保留省略与显式清空的区别。 */
export const CandidateScheduleConstraintFields = {
  onlyWeekends: z.boolean().nullable().optional(),
  maxDaysPerWeek: z.number().int().min(1).max(7).nullable().optional(),
  includeAnyTags: z.array(z.enum(SHIFT_TAGS)).optional(),
  excludeTags: z.array(z.enum(SHIFT_TAGS)).optional(),
  availableWindow: ScheduleWindowSchema.nullable().optional(),
  unavailableWindow: ScheduleWindowSchema.nullable().optional(),
  minShiftHours: z.number().positive().max(24).nullable().optional(),
  maxShiftHours: z.number().positive().max(24).nullable().optional(),
};
export const CandidateScheduleConstraintSchema = z
  .object(CandidateScheduleConstraintFields)
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.minShiftHours != null &&
      value.maxShiftHours != null &&
      value.minShiftHours > value.maxShiftHours
    ) {
      ctx.addIssue({ code: 'custom', message: '每班最小时长不能大于最大时长' });
    }
  });

export type CandidateScheduleConstraint = z.infer<typeof CandidateScheduleConstraintSchema>;
export type ScheduleWindow = z.infer<typeof ScheduleWindowSchema>;
export interface TimeRange {
  startMinute: number;
  endMinute: number;
}
export interface ShiftSlot extends TimeRange {
  index: number;
  tags: ShiftTag[];
}
export type JobSchedule =
  | { arrangementType: '固定排班' | '组合排班制'; slots: ShiftSlot[]; tags: ShiftTag[] }
  | { arrangementType: '灵活排班'; window: TimeRange; minimumMinutes: number };
export interface ScheduleMatchResult {
  status: 'matched' | 'unmatched' | 'unknown';
  mode: 'tag' | 'time' | 'none';
  matchedSlotIndexes: number[];
  reason: string | null;
}

export function hasDailyScheduleConstraint(
  c: CandidateScheduleConstraint | null | undefined,
): boolean {
  return Boolean(
    c &&
      (c.includeAnyTags?.length ||
        c.excludeTags?.length ||
        c.availableWindow ||
        c.unavailableWindow ||
        c.minShiftHours != null ||
        c.maxShiftHours != null),
  );
}

export function hasScheduleConstraint(c: CandidateScheduleConstraint | null | undefined): boolean {
  return Boolean(
    c && (hasDailyScheduleConstraint(c) || c.onlyWeekends || c.maxDaysPerWeek != null),
  );
}

/** 仅用于读取尚未过期的会话记忆；新模型契约不再产出旧早晚班布尔值。 */
export const StoredScheduleConstraintSchema = z.object({
  ...CandidateScheduleConstraintFields,
  onlyEvenings: z.boolean().nullable().optional(),
  onlyMornings: z.boolean().nullable().optional(),
});
export type StoredScheduleConstraint = z.infer<typeof StoredScheduleConstraintSchema>;

/** 字段未出现时延续；明确的 null、[]、false 保留为撤销，不从旧值补回。 */
export function mergeScheduleConstraints(
  previous: StoredScheduleConstraint | null | undefined,
  patch: StoredScheduleConstraint | null | undefined,
): StoredScheduleConstraint {
  const next = {
    ...previous,
    ...Object.fromEntries(Object.entries(patch ?? {}).filter(([, value]) => value !== undefined)),
  };
  if (
    patch &&
    (patch.includeAnyTags?.length ||
      patch.availableWindow ||
      (patch.includeAnyTags !== undefined && previous?.includeAnyTags?.length) ||
      (patch.availableWindow !== undefined && previous?.availableWindow))
  ) {
    // 只有新的可出勤含义或对已明确条件的撤销才能替换旧早晚班含义。
    // 排除条件、无对应旧值的清空操作不应扩大候选人的可用范围。
    delete next.onlyEvenings;
    delete next.onlyMornings;
  }
  return next;
}

export function readScheduleConditions(stored: StoredScheduleConstraint): {
  conditions: CandidateScheduleConstraint;
  legacyUnresolved: boolean;
} {
  const { onlyEvenings, onlyMornings, ...conditions } = stored;
  return {
    conditions,
    legacyUnresolved: Boolean(
      (onlyEvenings || onlyMornings) &&
        !conditions.availableWindow &&
        !conditions.includeAnyTags?.length,
    ),
  };
}

export const SCHEDULE_CONSTRAINT_GUIDANCE =
  '候选人班次条件的本轮变更，省略字段延续记忆，数组替换，[]清空标签，null撤销时段/时长。' +
  '标签：early早班、morning上午、midday中班、afternoon下午、evening晚班、night夜班；开档=early；早上/早班=early或morning；白天=前四种，全天=全部。' +
  'includeAnyTags命中任一即可，excludeTags排除；明确钟点用availableWindow/unavailableWindow，只有起点或终点也可，跨日显式endDayOffset=1。具体时段优先于正向标签。' +
  '候选人仅问几点上下班、休息多久等岗位事实时，用inspect查已知岗位，不据此设置个人限制。接受某班次不等于只能该班次，拒绝用excludeTags或unavailableWindow。时间和独立负向标签同时生效口径不明确时先澄清。minShiftHours/maxShiftHours是每档班次时长。';
