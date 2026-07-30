/**
 * 确定性 repair 回归检测（纯函数，零 LLM）。
 *
 * 背景（2026-07-24 守卫审计）：二审只判「修复版是否违规」，不比较「相对首版是否退步」，
 * 导致两类已实际投递的坏修复：
 * - 结构压扁：首版逐行报名表/岗位详情被 repair 压成一句话流水账
 *   （trace batch_6a609570…、batch_6a606a01…）；
 * - 结论极性反转：首版给出具体岗位，修复版断言"附近没找到在招的岗位"
 *   （trace batch_6a606ac5…，同条消息内自相矛盾）。
 *
 * 追加形态（2026-07-27 守卫审计，v10.29.0 上线后仍存活的缺口）：
 * - 已确认事实被改动：repair 把工具盖章的面试日期星期翻错
 *   （trace batch_6a630be4…：首版"7月28日（周二）"来自 _confirmedInterviewTimeHuman
 *   代码计算，replan 近乎逐字照抄却改成"（周一）"，二审 pass 后已投递）；
 * - 既成副作用被降级：booking 已成功、首版如实说"已提交报名"，修复版改口
 *   "正在帮你核对并提交，稍后给你回执"——回执永远不会来（同 trace）。
 *
 * 命中任一形态即判定 repair 回归；runner 再结合首版是否明确可发送决定：
 * 可发送才允许回退首版，首版已明确不可发送则两版都不投递。检测刻意保守：
 * 宁可漏判交给二审，不误伤正常的精简改写。
 */

import { QUANTIFIED_JOB_FACT_PATTERN } from './job-fact-signals.util';

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
   * - false：调用过查岗，但所有结果均无可用岗位；
   * - undefined：本轮未查岗或无法判定。
   *
   * 只有明确为 false 时，才允许 repair 把首版无依据的岗位列表纠正成无岗口径，
   * 避免把“删除幻觉事实”误判成结构压扁/结论反转。
   */
  jobEvidenceAvailable?: boolean;
  /** 仅测试注入；生产走系统时钟。用于把"M月D日"推断到最近的完整年份以计算真实星期。 */
  now?: Date;
}

/** 表单字段行：`姓名：` / `联系电话：13xxx` / `面试时间（…）：` 等短标签开头的行。 */
const FORM_FIELD_LINE_PATTERN = /^[-•\s]*[^：:\n]{1,14}[：:]/u;

/**
 * 岗位事实行：含距离/时薪/班次时段等硬数据的行。首版出现多行即认为在向候选人
 * 展示具体岗位内容。定义与语义 shadow 门控共用，见 job-fact-signals.util.ts。
 */
const JOB_FACT_PATTERN = QUANTIFIED_JOB_FACT_PATTERN;

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
    (line) => FORM_FIELD_LINE_PATTERN.test(line) || JOB_FACT_PATTERN.test(line),
  ).length;
}

function countJobFactLines(text: string): number {
  return splitLines(text).filter((line) => JOB_FACT_PATTERN.test(line)).length;
}

/** 日期+星期标注：`7月28日（周二）` / `7 月 28 日（星期二）`。捕获组：月、日、星期字。 */
const DATE_WEEKDAY_PATTERN =
  /(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[（(]\s*(?:周|星期)([一二三四五六日天])\s*[)）]/gu;

const WEEKDAY_CHAR_TO_INDEX: Record<string, number> = {
  日: 0,
  天: 0,
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
};

/** 提取文本中的日期→星期映射；同一日期在文中标注冲突时视为不可信，剔除。 */
function extractDateWeekdays(text: string): Map<string, number> {
  const result = new Map<string, number>();
  const conflicted = new Set<string>();
  for (const match of text.matchAll(DATE_WEEKDAY_PATTERN)) {
    const key = `${Number(match[1])}-${Number(match[2])}`;
    const weekday = WEEKDAY_CHAR_TO_INDEX[match[3]];
    if (weekday === undefined) continue;
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
 * - polarity_reversed：首版含 ≥2 行岗位事实（正在展示具体岗位）且自身没有无岗断言，
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

  const firstJobFactLines = countJobFactLines(first);
  const removesUngroundedJobClaims =
    context?.jobEvidenceAvailable === false &&
    firstJobFactLines >= 2 &&
    !NO_JOB_CLAIM_PATTERN.test(first) &&
    NO_JOB_CLAIM_PATTERN.test(revised);

  const firstStructured = countStructuredLines(first);
  if (!removesUngroundedJobClaims && firstStructured >= 3) {
    const revisedStructured = countStructuredLines(revised);
    const collapsed =
      revisedStructured * 3 < firstStructured && revised.length < first.length * 0.6;
    if (collapsed) return 'structure_collapsed';
  }

  if (
    !removesUngroundedJobClaims &&
    firstJobFactLines >= 2 &&
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
