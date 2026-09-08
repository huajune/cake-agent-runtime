import { asRecord, isRecord } from '@infra/utils/object.util';
/**
 * 岗位工作时间语义分类器 + 候选人班次约束匹配。
 *
 * 业务背景：候选人常表达"只能周末 / 只做晚班 / 每周最多两天 / 做一休一"等
 * 班次硬约束，岗位 workTime 字段里也有"每天 / 做六休一 / 周四六日都要 /
 * 早开晚结 05:00-23:00"等强排班描述。模型自己解读这些关键词容易误判
 * （把"每天"说成"周末能排"），所以在工具层把语义分类做出来。
 */

/**
 * 岗位排班语义类型：
 * - requires_full_week：全周强制（每天 / 周一至周日 / 做六休一 / 早开晚结 / 05:00-23:00）
 * - mandatory_weekend_days：周末必须给班（"周四六日都要 / 周六周日必到"）
 * - weekend_only_compatible：明确允许只周末做
 * - evening_compatible：明确含晚班时段
 * - morning_compatible：明确含早班时段
 * - low_weekly_frequency：结构化数据明确每周出勤不超过 2 天（只说明周频，不说明日内时段）
 * - flexible：自定义工时 / 可选时段 / 短班灵活
 * - unknown：数据缺失
 *
 * 同岗位可同时属于多个语义（如既"requires_full_week"又"evening_compatible"），
 * 因此返回字符串数组。
 */
export type ScheduleSemantic =
  | 'requires_full_week'
  | 'mandatory_weekend_days'
  | 'weekend_only_compatible'
  | 'evening_compatible'
  | 'morning_compatible'
  | 'low_weekly_frequency'
  | 'shift_rotation'
  | 'flexible'
  | 'unknown';

// 注意：「固定排班」不在此列——现网 dayWorkTime.arrangementType 的「固定排班」是
// **时段固定**标签（相对自由排班/自定义工时），与每周出勤频次无关，可与
// 「每周至少上岗 2 天」共存。误收会把"固定排班 + 每周至少 2 天"的周末岗判成
// requires_full_week，只能周末的候选人被谎称无岗。每周全勤判定交给结构化
// weeklyWorkDays>=5 与显式文本信号。
const FULL_WEEK_PATTERNS = [
  /每天/,
  /周一至周日/,
  /做六休一/,
  /早开晚结/,
  /05[:：]00\s*[-—–~]\s*23[:：]00/,
];

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

const EVENING_PATTERNS = [
  /晚班/,
  /夜班/,
  /通宵/,
  /17[:：]\d{2}.*23[:：]\d{2}/,
  /18[:：]\d{2}.*22[:：]\d{2}/,
];

const MORNING_PATTERNS = [
  /早班/,
  /开档/,
  /早开档/,
  /(?:0[6-9]|1[01])[:：]\d{2}.*(?:09|10|11)[:：]\d{2}/,
];

const FLEXIBLE_PATTERNS = [/自定义工时/, /可选时段/, /灵活排班/, /短班/, /午高峰/];

/** 早晚班轮排/轮班：候选人只做某一时段时，轮排岗位会把他排进另一时段，不能当"含晚班"就放行。 */
const SHIFT_ROTATION_PATTERNS = [/早晚班/, /轮排/, /轮班/, /轮流上/, /倒班/, /早开晚结/];

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
  if (EVENING_PATTERNS.some((p) => p.test(haystack))) out.add('evening_compatible');
  if (MORNING_PATTERNS.some((p) => p.test(haystack))) out.add('morning_compatible');
  if (FLEXIBLE_PATTERNS.some((p) => p.test(haystack))) out.add('flexible');
  if (SHIFT_ROTATION_PATTERNS.some((p) => p.test(haystack))) out.add('shift_rotation');

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

  let weeklyWorkDays = numberOf(wm.perWeekWorkDays);
  if (weeklyWorkDays === null && unit === '天' && /至少/.test(limitType)) {
    weeklyWorkDays = numberOf(wm.onWorkTime);
  }

  if (weeklyWorkDays !== null && weeklyWorkDays >= 5) {
    return ['requires_full_week'];
  }
  // 每周出勤门槛 ≤2 天：纯周末（周六+周日）即可满足，且与“每周最多两天”兼容。
  // 这只是一条周频信号，不能推导日内时段灵活；必须与 flexible 分开，避免误放
  // “只做晚班/只做早班”的候选人。3-4 天维持保守排除（仅两个周末日无法满足）。
  if (weeklyWorkDays !== null && weeklyWorkDays <= 2) {
    return ['low_weekly_frequency'];
  }
  return [];
}

function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

/**
 * 候选人班次约束（来自 [本轮解析线索] / [会话记忆] / 候选人当前消息）：
 *
 * - onlyWeekends：候选人说"只能周末 / 周末才有空"
 * - onlyEvenings：候选人说"只做晚班 / 下班后才能 / 晚上 X 到 Y"
 * - onlyMornings：候选人说"只做早班"
 * - maxDaysPerWeek：候选人说"每周最多 N 天"
 */
export interface CandidateScheduleConstraint {
  onlyWeekends?: boolean;
  onlyEvenings?: boolean;
  onlyMornings?: boolean;
  maxDaysPerWeek?: number;
  /**
   * 候选人可上班的具体时段（HH:MM，end 可为 24:00 或跨午夜小于 start）。
   * 与 onlyEvenings 这类粗粒度标签不同，它是包含关系判定：班次必须整段落在窗口内。
   */
  availableWindow?: { start: string; end: string } | null;
}

function toMinutes(hm: string): number | null {
  const match = hm.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 24 || m > 59) return null;
  return h * 60 + m;
}

/** 把 [start,end] 展开成分钟区间；跨午夜或 end≤start 时 end 补 24h。 */
function toRange(start: string, end: string): [number, number] | null {
  const s = toMinutes(start);
  let e = toMinutes(end);
  if (s === null || e === null) return null;
  if (e <= s) e += 24 * 60;
  return [s, e];
}

/**
 * 候选人可上班时段 ↔ 岗位班次的包含判定（badcase j4kb5ijm：候选人「晚上 6 点半到 24 点」，
 * 22:00-次日 07:00 夜班与 15:00-23:00 班次都被当成"晚班兼容"推了出去）。
 *
 * - pick_one：任一班次整段落在窗口内即匹配；
 * - all_required：全部班次都要落在窗口内；
 * - flexible（窗口式排班）：岗位窗口与候选人窗口的交集 ≥ 每日最少工时（缺省 2h）即匹配；
 * - 无具体时段：未知，不剔除（返回 matched=true, unknown=true）。
 */
export function matchAvailableWindow(
  shifts: {
    slots: Array<{ start: string; end: string }>;
    arrangement: 'pick_one' | 'all_required' | 'flexible' | 'unknown';
    perDayMinHours: number | null;
  },
  window: { start: string; end: string },
): { matched: boolean; unknown?: boolean; reason?: string } {
  const win = toRange(window.start, window.end);
  if (!win) return { matched: true, unknown: true };
  if (shifts.slots.length === 0) return { matched: true, unknown: true };
  const label = `${window.start}-${window.end}`;
  // 候选人窗口跨午夜（22:00-06:00 → [1320,1800]）时，落在后半夜的班次（00:00-06:00 → [0,360]）
  // 要平移一天再比，否则整段在窗口内的班次会被误判为不匹配。
  const DAY = 24 * 60;
  const contained = (range: [number, number]): boolean =>
    (range[0] >= win[0] && range[1] <= win[1]) ||
    (range[0] + DAY >= win[0] && range[1] + DAY <= win[1]);
  const overlapOf = (range: [number, number]): number =>
    Math.max(
      Math.min(range[1], win[1]) - Math.max(range[0], win[0]),
      Math.min(range[1] + DAY, win[1]) - Math.max(range[0] + DAY, win[0]),
    );
  const fits = (slot: { start: string; end: string }): boolean => {
    const range = toRange(slot.start, slot.end);
    if (!range) return false;
    return contained(range);
  };
  if (shifts.arrangement === 'flexible') {
    const slot = shifts.slots[0];
    const range = toRange(slot.start, slot.end);
    if (!range) return { matched: true, unknown: true };
    const overlap = overlapOf(range);
    const need = Math.max(shifts.perDayMinHours ?? 2, 1) * 60;
    return overlap >= need
      ? { matched: true }
      : {
          matched: false,
          reason: `岗位排班窗口 ${slot.start}-${slot.end} 与候选人可上班时段 ${label} 重叠不足`,
        };
  }
  if (shifts.arrangement === 'all_required') {
    return shifts.slots.every(fits)
      ? { matched: true }
      : { matched: false, reason: `岗位班次需全部出勤，有班次不在候选人可上班时段 ${label} 内` };
  }
  return shifts.slots.some(fits)
    ? { matched: true }
    : {
        matched: false,
        reason: `岗位班次 ${shifts.slots.map((s) => `${s.start}-${s.end}`).join(' / ')} 都不在候选人可上班时段 ${label} 内`,
      };
}

/**
 * 判断岗位语义是否与候选人约束兼容。
 *
 * 规则（保守，只在明确冲突时返回 false）：
 * - onlyWeekends：requires_full_week / mandatory_weekend_days 都不兼容（候选人不能配合工作日）；
 *   只有 weekend_only_compatible / low_weekly_frequency / flexible 才兼容
 * - onlyEvenings：requires_full_week / morning_only 不兼容；evening_compatible / flexible 兼容
 * - onlyMornings：evening_only 不兼容；morning_compatible / flexible 兼容
 * - maxDaysPerWeek <= 2：requires_full_week / mandatory_weekend_days 不兼容；
 *   low_weekly_frequency 明确兼容
 *
 * 返回 { matched, reason }：reason 给具体不兼容原因。
 */
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
    if (!has('weekend_only_compatible') && !has('low_weekly_frequency') && !has('flexible')) {
      return { matched: false, reason: '岗位排班未明确允许只做周末' };
    }
  }

  if (constraint.onlyEvenings) {
    // 「只做晚班」是日内时段约束，与每周出勤频次正交：做六休一的 18:00-22:00 晚班对
    // 只能晚上来的候选人恰恰是匹配的。此前把 requires_full_week 也算冲突，会把候选人
    // 点名的晚班岗整批剔除并回"排班对不上"（badcase ce20d0l8：候选人「只做晚班 18-22」，
    // 岗位 18:00-22:00 后厨晚班被以全周强排班为由剔除）。频次冲突只由 onlyWeekends /
    // maxDaysPerWeek 判定。
    if (has('shift_rotation')) {
      return { matched: false, reason: '岗位早晚班轮排，与"只做晚班"冲突' };
    }
    if (has('morning_compatible') && !has('evening_compatible')) {
      return { matched: false, reason: '岗位仅安排早班，与"只做晚班"冲突' };
    }
    if (!has('evening_compatible') && !has('flexible')) {
      return { matched: false, reason: '岗位排班未明确含晚班' };
    }
  }

  if (constraint.onlyMornings) {
    if (has('shift_rotation')) {
      return { matched: false, reason: '岗位早晚班轮排，与"只做早班"冲突' };
    }
    if (has('evening_compatible') && !has('morning_compatible')) {
      return { matched: false, reason: '岗位仅安排晚班，与"只做早班"冲突' };
    }
    if (!has('morning_compatible') && !has('flexible')) {
      return { matched: false, reason: '岗位排班未明确含早班' };
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
