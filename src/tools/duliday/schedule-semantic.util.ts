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
  | 'flexible'
  | 'unknown';

const FULL_WEEK_PATTERNS = [
  /每天/,
  /周一至周日/,
  /做六休一/,
  /早开晚结/,
  /固定排班/,
  /05[:：]00\s*[-—–~]\s*23[:：]00/,
];

const MANDATORY_WEEKEND_PATTERNS = [
  /周[四六日][\s、,，]*周[四六日]/,
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
  if (WEEKEND_ONLY_PATTERNS.some((p) => p.test(haystack))) out.add('weekend_only_compatible');
  if (EVENING_PATTERNS.some((p) => p.test(haystack))) out.add('evening_compatible');
  if (MORNING_PATTERNS.some((p) => p.test(haystack))) out.add('morning_compatible');
  if (FLEXIBLE_PATTERNS.some((p) => p.test(haystack))) out.add('flexible');

  if (out.size === 0) out.add('unknown');
  return Array.from(out);
}

/**
 * 候选人班次约束（来自 [本轮高置信线索] / [会话记忆] / 候选人当前消息）：
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
}

/**
 * 判断岗位语义是否与候选人约束兼容。
 *
 * 规则（保守，只在明确冲突时返回 false）：
 * - onlyWeekends：requires_full_week / mandatory_weekend_days 都不兼容（候选人不能配合工作日）；
 *   只有 weekend_only_compatible / flexible 才兼容
 * - onlyEvenings：requires_full_week / morning_only 不兼容；evening_compatible / flexible 兼容
 * - onlyMornings：evening_only 不兼容；morning_compatible / flexible 兼容
 * - maxDaysPerWeek <= 2：requires_full_week / mandatory_weekend_days 不兼容
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
    if (has('weekend_only_compatible') || has('flexible')) return { matched: true };
    if (has('requires_full_week')) {
      return { matched: false, reason: '岗位是全周强排班，与"只做周末"冲突' };
    }
    if (has('mandatory_weekend_days')) {
      // 周六周日要给班 + 工作日也要给班 → 不能"只周末"
      return { matched: false, reason: '岗位除周末外还要工作日给班，与"只做周末"冲突' };
    }
    return { matched: false, reason: '岗位排班未明确允许只做周末' };
  }

  if (constraint.onlyEvenings) {
    if (has('evening_compatible') || has('flexible')) return { matched: true };
    if (has('morning_compatible') && !has('evening_compatible')) {
      return { matched: false, reason: '岗位仅安排早班，与"只做晚班"冲突' };
    }
    if (has('requires_full_week')) {
      return { matched: false, reason: '岗位是全周强排班，与"只做晚班"可能冲突，需进一步确认' };
    }
    return { matched: false, reason: '岗位排班未明确含晚班' };
  }

  if (constraint.onlyMornings) {
    if (has('morning_compatible') || has('flexible')) return { matched: true };
    if (has('evening_compatible') && !has('morning_compatible')) {
      return { matched: false, reason: '岗位仅安排晚班，与"只做早班"冲突' };
    }
    return { matched: false, reason: '岗位排班未明确含早班' };
  }

  if (typeof constraint.maxDaysPerWeek === 'number' && constraint.maxDaysPerWeek <= 2) {
    if (has('requires_full_week') || has('mandatory_weekend_days')) {
      return {
        matched: false,
        reason: `岗位需要每周≥3 天给班，与候选人"每周最多 ${constraint.maxDaysPerWeek} 天"冲突`,
      };
    }
  }

  return { matched: true };
}
