import type { CandidateScheduleConstraint } from '@resolution/schedule/types';
import { asRecord, isRecord } from '@infra/utils/object.util';
/**
 * 既有周频约束的解释与匹配。日内班次只由 resolution/schedule 的结构化规则处理。
 * 同岗位可有多个周频信号；不得从日内跨度推导每周出勤要求。
 */
export type ScheduleSemantic =
  | 'requires_full_week'
  | 'mandatory_weekend_days'
  | 'weekend_only_compatible'
  | 'low_weekly_frequency'
  | 'unknown';

// 注意：「固定排班」不在此列——现网 dayWorkTime.arrangementType 的「固定排班」是
// **时段固定**标签（相对自由排班/自定义工时），与每周出勤频次无关，可与
// 「每周至少上岗 2 天」共存。误收会把"固定排班 + 每周至少 2 天"的周末岗判成
// requires_full_week，只能周末的候选人被谎称无岗。每周全勤判定交给结构化
// weeklyWorkDays>=5 与显式文本信号。
const FULL_WEEK_PATTERNS = [/每天/, /周一至周日/, /做六休一/];

const MANDATORY_WEEKEND_PATTERNS = [
  /周四[\s、,，]*周[六日]/,
  /周六[\s、,，]*周[四日]/,
  /周日[\s、,，]*周[四六]/,
  /周[六日]都要(给班|上班)/,
  /周[六日]必到/,
  /周末必到/,
];

const WEEKEND_ONLY_PATTERNS = [
  /只(?:做|排|能)?周末/,
  /仅周末/,
  /可只(?:做|排)周末/,
  /(?:只|仅)?周末班/,
];

/**
 * 根据 workTime 段落 + interview/requirement 备注文本，分类岗位排班语义。
 */
export function classifyScheduleSemantic(input: {
  workTimeText: string | null | undefined;
  interviewRemark?: string | null;
  requirementRemark?: string | null;
}): ScheduleSemantic[] {
  const haystack = [input.workTimeText, input.interviewRemark, input.requirementRemark]
    .filter((t): t is string => Boolean(t))
    .join('\n');
  if (!haystack) return ['unknown'];

  const out = new Set<ScheduleSemantic>();
  if (FULL_WEEK_PATTERNS.some((p) => p.test(haystack))) out.add('requires_full_week');
  if (MANDATORY_WEEKEND_PATTERNS.some((p) => p.test(haystack))) out.add('mandatory_weekend_days');
  if (WEEKEND_ONLY_PATTERNS.some((p) => p.test(haystack))) {
    out.add('weekend_only_compatible');
  }

  // 海绵2.0 结构化补充：从 weekAndMonthWorkTime 派生"全周强排班"等无法靠文本识别的语义。
  for (const semantic of deriveStructuredScheduleSemantics(input.workTimeText)) {
    out.add(semantic);
  }

  if (out.size === 0) out.add('unknown');
  return Array.from(out);
}

/**
 * 从海绵2.0 结构化 workTime 派生排班语义。
 *
 * 新结构不再下发具体星期分配（combinedArrangement 无星期、无 customnWorkTimeList），
 * 因此"只做周末"这种正向兼容信号无法从结构判定（保守起见不再 add weekend_only_compatible，
 * 候选人"只周末"时会被 matchScheduleConstraint 保守排除，方向安全）。
 *
 * 但每周出勤天数仍可从 weekAndMonthWorkTime 读出：
 * - perWeekWorkDays（如 6 = 做六休一）
 * - 或 onWorkLimitType="至少上岗" + onWorkTimeUnit="天" + onWorkTime（每周至少 N 天）
 * 出勤 ≥5 天即视为全周强排班（requires_full_week），用于拦截"只周末/每周最多两天"。
 */
function deriveStructuredScheduleSemantics(
  workTimeText: string | null | undefined,
): ScheduleSemantic[] {
  if (!workTimeText) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(workTimeText);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];

  const wm = asRecord(parsed.weekAndMonthWorkTime);
  if (!wm) return [];

  const limitType = typeof wm.onWorkLimitType === 'string' ? wm.onWorkLimitType : '';
  const unit = typeof wm.onWorkTimeUnit === 'string' ? wm.onWorkTimeUnit : '';

  let weeklyWorkDays = resolveWeeklyWorkDays(wm).days;
  if (weeklyWorkDays === null && unit === '天' && /至少/.test(limitType)) {
    weeklyWorkDays = numberOf(wm.onWorkTime);
  }

  if (weeklyWorkDays !== null && weeklyWorkDays >= 5) {
    return ['requires_full_week'];
  }
  // 每周出勤门槛 ≤2 天：纯周末（周六+周日）即可满足，且与“每周最多两天”兼容。
  // 这只是一条周频信号，不能推导日内时段灵活，避免误放
  // “只做晚班/只做早班”的候选人。3-4 天维持保守排除（仅两个周末日无法满足）。
  if (weeklyWorkDays !== null && weeklyWorkDays <= 2) {
    return ['low_weekly_frequency'];
  }
  return [];
}

/**
 * 每周实际出勤天数（perWeekWorkDays 的唯一解释处）。
 *
 * perWeekWorkDays / perWeekRestDays 成对出现且相加≠7 时是循环班型（做一休一=上1休1轮换，
 * 工作日也要到岗），此时 perWeekWorkDays 不是周频，须换算成平均每周天数；直接当周频读会把
 * 做一休一当成"每周 1 天"，既在卡片上误报，又被判成低频岗放给只做周末的候选人。
 */
export function resolveWeeklyWorkDays(wm: {
  perWeekWorkDays?: unknown;
  perWeekRestDays?: unknown;
}): {
  days: number | null;
  cyclic: boolean;
} {
  const work = numberOf(wm.perWeekWorkDays);
  const rest = numberOf(wm.perWeekRestDays);
  if (work === null) return { days: null, cyclic: false };
  if (rest === null || work + rest === 7 || work + rest <= 0) return { days: work, cyclic: false };
  return { days: Math.floor((7 * work) / (work + rest)), cyclic: true };
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

export function matchScheduleConstraint(
  semantics: ScheduleSemantic[],
  constraint: CandidateScheduleConstraint | undefined | null,
): { matched: boolean; reason?: string } {
  if (!constraint) return { matched: true };
  const has = (s: ScheduleSemantic) => semantics.includes(s);

  if (constraint.onlyWeekends) {
    // 冲突语义必须先于宽松语义判定。海绵岗位可能同时标记“灵活排班”和
    // “做六休一/每周至少 5 天”；此时 flexible 只表示日内时段可协调，不能覆盖
    // 每周出勤频次。历史 badcase：只做周末的候选人被推荐全周岗位。
    if (has('requires_full_week')) {
      return { matched: false, reason: '岗位是全周强排班，与"只做周末"冲突' };
    }
    if (has('mandatory_weekend_days')) {
      // 周六周日要给班 + 工作日也要给班 → 不能"只周末"
      return { matched: false, reason: '岗位除周末外还要工作日给班，与"只做周末"冲突' };
    }
    if (!has('weekend_only_compatible') && !has('low_weekly_frequency')) {
      return { matched: false, reason: '岗位排班未明确允许只做周末' };
    }
  }

  if (typeof constraint.maxDaysPerWeek === 'number' && constraint.maxDaysPerWeek <= 2) {
    if (has('requires_full_week') || has('mandatory_weekend_days')) {
      return {
        matched: false,
        reason: `岗位需要每周≥3 天给班，与候选人"每周最多 ${constraint.maxDaysPerWeek} 天"冲突`,
      };
    }
    if (has('low_weekly_frequency')) return { matched: true };
  }

  return { matched: true };
}
