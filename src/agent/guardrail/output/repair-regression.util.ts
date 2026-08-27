import { CHINESE_WEEKDAY_ISO, isoWeekdayToJsDay } from '@infra/utils/chinese-numeral.util';
import { QUANTIFIED_JOB_FACT_PATTERN } from './job-fact-signals.util';

/**
 * 确定性 repair 回归检测（纯函数，零 LLM）。
 *
 * 二审只能判断修复版本身是否违规，还需将它与首版比较，防止以下退步：
 * - 报名表或岗位详情的结构被压扁；
 * - 有岗/无岗结论极性反转；
 * - 工具确认的日期或星期被改错；
 * - 已完成的副作用被降级为待办；
 *
 * 命中任一形态即判定 repair 回归；runner 再结合首版是否明确可发送决定：
 * 可发送才允许回退首版，首版已明确不可发送则两版都不投递。检测刻意保守：
 * 宁可漏判交给二审，不误伤正常的精简改写。
 */

export type RepairRegressionKind =
  | 'structure_collapsed'
  | 'polarity_reversed'
  | 'fact_mutated'
  | 'commitment_downgraded';

export interface RepairRegressionContext {
  /** agent-runner 的 summarizeCommittedSideEffects 产物；含 duliday_interview_booking 时启用副作用降级检测。 */
  committedSideEffects?: string;
  /**
   * 本轮 duliday_job_list 是否返回过可用岗位证据：
   * - true：至少一次调用有可用岗位结果；
   * - false：本轮无可用岗位证据（查岗全空，或根本没查——零查岗轮的岗位事实
   *   必然无本轮工具支撑，PR #1000 评审 P0-9）；
   * - undefined：调用方无法判定（仅测试/旁路）。
   *
   * 只有明确为 false 时，才允许 repair 把首版无依据的岗位列表纠正成无岗口径，
   * 避免把“删除幻觉事实”误判成结构压扁/结论反转。
   */
  jobEvidenceAvailable?: boolean;
  /**
   * 首版被出站守卫封禁的规则 id（agent-runner 传 decision.blockedRuleIds）。
   * 含泄漏类规则（STRUCTURE_IS_VIOLATION_RULE_IDS）时跳过 structure_collapsed：
   * 首版的"结构行"正是违规内容本身（内部分析清单/标签行/规则引用），压扁是修复
   * 目标而非退化。其余三个检测器不受影响。
   */
  firstBlockedRuleIds?: readonly string[];
  /** 仅测试注入；生产走系统时钟。用于把"M月D日"推断到最近的完整年份以计算真实星期。 */
  now?: Date;
}

/**
 * 首版命中这些规则时，首版整体不是候选人可见正文（内部分析/自我旁白/异常
 * completion），结构化行统计的分母是脏的——被数进"结构"的正是违规脚手架，
 * structure_collapsed 对这类首版必然误报（2026-08-27 生产案 batch_6a8faabb…：
 * 修复版合格，却因结构坍缩两版都不投，候选人整轮静默）。
 */
const STRUCTURE_IS_VIOLATION_RULE_IDS: ReadonlySet<string> = new Set([
  'internal_output_leak',
  'meta_narration_reply',
  'invalid_model_output',
]);

/** 表单字段行：`姓名：` / `联系电话：13xxx` / `面试时间（…）：` 等短标签开头的行。 */
const FORM_FIELD_LINE_PATTERN = /^[-•\s]*[^：:\n]{1,14}[：:]/u;

/** 无岗断言：修复版声称附近/该区域没有（在招）岗位。 */
const NO_JOB_CLAIM_PATTERN =
  /(?:没找到|没查到|未找到|找不到|暂时?没有|暂无)[^。！？!?\n]{0,12}(?:岗位|工作|在招)|(?:岗位|工作)[^。！？!?\n]{0,8}(?:没有|暂无|没找到|没查到)/u;

function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function countStructuredLines(text: string): number {
  return splitLines(text).filter(
    (line) => FORM_FIELD_LINE_PATTERN.test(line) || QUANTIFIED_JOB_FACT_PATTERN.test(line),
  ).length;
}

/**
 * 岗位事实的**出现次数**（不是行数）。
 *
 * 2026-07-30 审计 P2-8：若按行统计，首版把多个岗位写成一段散文（单行）时
 * 计数恒为 1，`polarity_reversed` 的 `>= 2` 门槛永远够不到——2026-07-27 生产实例
 * batch_6a6726d4… 首版散文式给出最高薪岗位、修复版反转成"附近 10 公里内没岗位"，
 * 两个检测器都没拦住并已投递。全局计数下，散文与分行结构同等达标。
 */
function countJobFactOccurrences(text: string): number {
  return text.match(new RegExp(QUANTIFIED_JOB_FACT_PATTERN, 'gu'))?.length ?? 0;
}

/** 日期+星期标注：`7月28日（周二）` / `7 月 28 日（星期二）`。捕获组：月、日、星期字。 */
const DATE_WEEKDAY_PATTERN =
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[（(]\s*(?:周|星期)([一二三四五六日天])\s*[)）]/gu;

/** 提取文本中的日期→星期映射；同一日期在文中标注冲突时视为不可信，剔除。 */
function extractDateWeekdays(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const match of text.matchAll(DATE_WEEKDAY_PATTERN)) {
    const key = `${Number(match[1])}-${Number(match[2])}`;
    const isoWeekday = CHINESE_WEEKDAY_ISO[match[3]];
    if (isoWeekday === undefined) continue;
    const weekday = isoWeekdayToJsDay(isoWeekday);
    if (result.has(key) && result.get(key) !== weekday) conflicted.add(key);
    result.set(key, weekday);
  }
  for (const key of conflicted) result.delete(key);
  return result;
}

/**
 * 把"M月D日"推断到距 now 最近的年份并计算真实星期（0=周日）。
 * 面试日期总在近期，就近年份消歧足够；非法日期（如 2月30日）返回 null。
 */
function computeActualWeekday(month: number, day: number, now: Date): number | null {
  let best: Date | null = null;
  for (const year of [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1]) {
    const candidate = new Date(year, month - 1, day);
    // Date 对非法日期会进位（2月30日→3月2日），进位即视为非法。
    if (candidate.getMonth() !== month - 1 || candidate.getDate() !== day) continue;
    if (
      best === null ||
      Math.abs(candidate.getTime() - now.getTime()) < Math.abs(best.getTime() - now.getTime())
    ) {
      best = candidate;
    }
  }
  return best === null ? null : best.getDay();
}

/** 首版对已成事实的成功宣称：已提交报名/报名成功/已帮你预约等。 */
const BOOKING_DONE_PATTERN =
  /已(?:经)?(?:帮你)?(?:成功)?(?:提交|报名|预约|约好)|(?:报名|预约|提交)(?:已(?:经)?)?成功/u;

/** 修复版的进行时降级：正在提交/稍后给你回执/马上帮你报名——副作用已生效时这是空头等待。 */
const BOOKING_PENDING_PATTERN =
  /正在(?:帮你)?[^，。；\n]{0,10}(?:提交|报名|预约|核对)|稍后[^，。；\n]{0,8}(?:回执|结果|确认|通知)|(?:马上|这就)(?:帮你)?[^，。；\n]{0,6}(?:提交|报名|预约)/u;

/**
 * 检测修复版相对首版是否发生回归。返回回归形态；未检出返回 null。
 *
 * - structure_collapsed：首版含 ≥3 行结构化内容（表单字段/岗位事实），修复版结构化行数
 *   掉到首版 1/3 以下且总长缩水到 60% 以下。单独的长度缩水不算——精简是合法修复。
 *   首版命中泄漏类封禁规则时豁免（见 STRUCTURE_IS_VIOLATION_RULE_IDS）。
 * - polarity_reversed：首版含 ≥2 处岗位事实（正在展示具体岗位）且自身没有无岗断言，
 *   修复版新增了"附近没有岗位"类断言。首版本来就说无岗时不判（无极性变化）。
 * - fact_mutated：首版与修复版对同一个"M月D日"标注了不同星期，且首版星期与真实
 *   历法一致——修复版把对的改错了。首版本来就错、修复版纠正时不判（那是修好）。
 * - commitment_downgraded：booking 副作用已生效（committedSideEffects 含
 *   duliday_interview_booking），首版如实宣称已提交，修复版删掉成功宣称、改口
 *   "正在提交/稍后回执"——承诺的后续永远不会来。
 */
export function detectRepairRegression(
  firstText: string,
  revisedText: string,
  context?: RepairRegressionContext,
): RepairRegressionKind | null {
  const first = firstText.trim();
  const revised = revisedText.trim();
  if (!first || !revised || first === revised) return null;

  const firstJobFacts = countJobFactOccurrences(first);
  const removesUngroundedJobClaims =
    context?.jobEvidenceAvailable === false &&
    firstJobFacts >= 2 &&
    !NO_JOB_CLAIM_PATTERN.test(first) &&
    NO_JOB_CLAIM_PATTERN.test(revised);

  const firstStructureIsViolation = (context?.firstBlockedRuleIds ?? []).some((ruleId) =>
    STRUCTURE_IS_VIOLATION_RULE_IDS.has(ruleId),
  );

  const firstStructured = countStructuredLines(first);
  if (!removesUngroundedJobClaims && !firstStructureIsViolation && firstStructured >= 3) {
    const revisedStructured = countStructuredLines(revised);
    const collapsed =
      revisedStructured * 3 < firstStructured && revised.length < first.length * 0.6;
    if (collapsed) return 'structure_collapsed';
  }

  if (
    !removesUngroundedJobClaims &&
    firstJobFacts >= 2 &&
    !NO_JOB_CLAIM_PATTERN.test(first) &&
    NO_JOB_CLAIM_PATTERN.test(revised)
  ) {
    return 'polarity_reversed';
  }

  const now = context?.now ?? new Date();
  const firstDates = extractDateWeekdays(first);
  if (firstDates.size > 0) {
    for (const [key, revisedWeekday] of extractDateWeekdays(revised)) {
      const firstWeekday = firstDates.get(key);
      if (firstWeekday === undefined || firstWeekday === revisedWeekday) continue;
      const [month, day] = key.split('-').map(Number);
      // 只在首版标注与真实历法一致时判回归——首版本来就错、修复版纠正属于修好；
      // 年份推断失败（真实星期未知）时保守放行，交给二审。
      if (computeActualWeekday(month, day, now) === firstWeekday) return 'fact_mutated';
    }
  }

  if (
    (context?.committedSideEffects ?? '').includes('duliday_interview_booking') &&
    BOOKING_DONE_PATTERN.test(first) &&
    !BOOKING_DONE_PATTERN.test(revised) &&
    BOOKING_PENDING_PATTERN.test(revised)
  ) {
    return 'commitment_downgraded';
  }

  return null;
}
