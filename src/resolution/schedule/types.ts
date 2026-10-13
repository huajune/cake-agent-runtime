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
  preferFlexibleSchedule: z.boolean().nullable().optional(),
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
/**
 * 灵活排班的 window 是候选人须整段接受的排班区间，minimumMinutes 是门店在区间内安排的每班时长；
 * tags 按排班区间计算，与固定／组合的班次标签同一定义。
 */
export type JobSchedule =
  | { arrangementType: '固定排班' | '组合排班制'; slots: ShiftSlot[]; tags: ShiftTag[] }
  | { arrangementType: '灵活排班'; window: TimeRange; minimumMinutes: number; tags: ShiftTag[] };
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

/**
 * 旧契约的时段是自由字符串，以“结束不晚于开始”表示跨午夜，也可能缺少小时补零。
 * 读取时按旧语义换成显式 endDayOffset；含义无法确定的时段（起止相同、非钟点）不擅自放宽，
 * 移除后以 legacyWindowUnresolved 标记待确认，避免整份会话事实因一个旧时段校验失败被丢弃。
 */
function normalizeStoredWindow(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value;
  const pad = (clock: unknown) =>
    typeof clock === 'string' && /^\d:[0-5]\d$/.test(clock) ? `0${clock}` : clock;
  const window = { ...(value as Record<string, unknown>) };
  window.start = pad(window.start);
  window.end = pad(window.end);
  if (window.start === undefined) delete window.start;
  if (window.end === undefined) delete window.end;
  if (
    typeof window.start === 'string' &&
    typeof window.end === 'string' &&
    window.endDayOffset === undefined
  ) {
    if (window.end === '00:00' && window.start !== '00:00') window.end = '24:00';
    else if (window.end < window.start) window.endDayOffset = 1;
  }
  return window;
}

const STORED_WINDOW_FIELDS = ['availableWindow', 'unavailableWindow'] as const;

function normalizeStoredConstraint(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const next: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of STORED_WINDOW_FIELDS) {
    if (next[field] === undefined || next[field] === null) continue;
    const window = normalizeStoredWindow(next[field]);
    if (ScheduleWindowSchema.safeParse(window).success) {
      next[field] = window;
    } else {
      delete next[field];
      next.legacyWindowUnresolved = true;
    }
  }
  return next;
}

/** 仅用于读取尚未过期的会话记忆；新模型契约不再产出旧早晚班布尔值。 */
export const StoredScheduleConstraintSchema = z.preprocess(
  normalizeStoredConstraint,
  z.object({
    ...CandidateScheduleConstraintFields,
    onlyEvenings: z.boolean().nullable().optional(),
    onlyMornings: z.boolean().nullable().optional(),
    legacyWindowUnresolved: z.literal(true).optional(),
  }),
);
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
  if (patch && (patch.includeAnyTags !== undefined || patch.availableWindow !== undefined)) {
    // 正向标签或可出勤时段的新值、显式撤销（[] / null）都替换旧早晚班含义；
    // 排除标签、不可用时段等无关补丁不应扩大候选人的可用范围。
    delete next.onlyEvenings;
    delete next.onlyMornings;
  }
  if (patch && (patch.availableWindow !== undefined || patch.unavailableWindow !== undefined)) {
    // 候选人重新给出或撤销时段后，旧时段的待确认状态即被替换。
    delete next.legacyWindowUnresolved;
  }
  return next;
}

export function readScheduleConditions(stored: StoredScheduleConstraint): {
  conditions: CandidateScheduleConstraint;
  legacyUnresolved: boolean;
} {
  const { onlyEvenings, onlyMornings, legacyWindowUnresolved, ...conditions } = stored;
  return {
    conditions,
    legacyUnresolved: Boolean(
      legacyWindowUnresolved ||
        ((onlyEvenings || onlyMornings) &&
          !conditions.availableWindow &&
          !conditions.includeAnyTags?.length),
    ),
  };
}

export const SCHEDULE_CONSTRAINT_GUIDANCE =
  '候选人班次条件的本轮变更，省略字段延续记忆，数组替换，[]清空标签，null撤销时段/时长。' +
  '标签：early早班、morning上午班、midday中班、afternoon下午班、evening晚班、night夜班；开档=early；早上/早晨/早班=early和morning；上午=morning；中午/午高峰=midday；下午=afternoon；晚上=evening；夜间/凌晨/通宵/大夜=night；白天=前四种，全天=全部。' +
  'includeAnyTags命中任一即可，excludeTags排除；明确钟点用availableWindow/unavailableWindow，只有起点或终点也可，跨日显式endDayOffset=1。有availableWindow时忽略正向标签、只按时段匹配；unavailableWindow只作额外排除，不替代正向标签；excludeTags与时段同时生效。' +
  '最早上班和最晚下班分别写availableWindow.start和end；只限制一侧时不得补另一侧（如晚上十点到凌晨只写start=22:00），也不得把未声明的其余时段改成unavailableWindow。unavailableWindow仅用于候选人明确不能出勤的区间。' +
  'preferFlexibleSchedule表示优先灵活排班，仅用于排序，不是硬性排班限制；false撤销偏好，省略延续记忆。候选人询问排班是固定还是自己选、门店安排还是自己定、能否换班等排班方式时，本次查岗传true让灵活排班岗位排前；仅询问不作为持续偏好保存。' +
  '候选人仅问几点上下班、休息多久等岗位事实时，用inspect查已知岗位，不据此设置个人限制。接受某班次不等于只能该班次，拒绝用excludeTags或unavailableWindow。minShiftHours/maxShiftHours是每档班次时长。';
