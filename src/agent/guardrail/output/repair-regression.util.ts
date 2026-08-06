import { QUANTIFIED_JOB_FACT_PATTERN } from './job-fact-signals.util';

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
 * 追加形态（2026-08-06 badcase chat 6a1e42c5，前四形态方向全是"已完成→降级"暴露的盲区）：
 * - 待办承诺被升级：首版"让同事帮你确认下能不能改"被守卫判 P0 承诺无支撑，repair 删掉承诺
 *   后用"你说的15:30这个时间没问题"填坑——首版只是没定，修复版成了已定，工单实际未改
 *   （trace …_1785977561594）。守卫这一轮是净负贡献：准确识别了风险，却产出更危险的话术。
 *
 * 命中任一形态即判定 repair 回归；runner 再结合首版是否明确可发送决定：
 * 可发送才允许回退首版，首版已明确不可发送则两版都不投递。检测刻意保守：
 * 宁可漏判交给二审，不误伤正常的精简改写。
 */

export type RepairRegressionKind =
  | 'structure_collapsed'
  | 'polarity_reversed'
  | 'fact_mutated'
  | 'commitment_downgraded'
  | 'commitment_upgraded';

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
  /**
   * 本轮触发的守卫规则 id（首审判定结果）。
   *
   * 零证据类规则（见 ZERO_EVIDENCE_RULE_IDS）触发时，repair 的**正确产物本来就是**
   * 删掉那些无出处的岗位事实——此时结构塌缩不是退化，是修对了。
   */
  triggeredRuleIds?: readonly string[];
  /** 仅测试注入；生产走系统时钟。用于把"M月D日"推断到最近的完整年份以计算真实星期。 */
  now?: Date;
}

/**
 * 零证据类规则：命中即说明首版的岗位事实没有工具出处。
 *
 * 2026-07-30 扫描日报建议动作 1 的完整口径是「repair 由零证据类规则触发，**或**该回合
 * duliday_job_list 返回 empty 时，禁用 structure_collapsed 回退」。PR #845 只实现了后半句
 * （jobEvidenceAvailable === false）。前半句在"本轮根本没调查岗工具"时才是唯一有效的判据
 * ——那种情况下 resolveJobEvidenceAvailability 返回 undefined 而非 false，逃生口够不着，
 * 修复版仍会被 structure_collapsed 回退，等于把 2026-07-29 那次整单编造投递原样复现一遍。
 */
const ZERO_EVIDENCE_RULE_IDS: ReadonlySet<string> = new Set([
  'settlement_no_evidence_assertion',
  'job_facts_without_any_lookup',
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

/**
 * 承诺类规则：命中即说明守卫已认定首版存在"无真实动作支撑的跟进承诺"。
 * commitment_upgraded 只在这些规则触发的轮次生效——正常轮次里"没问题"是合法应答，
 * 无差别检测会把大量正常改写判成回归。
 */
const PROMISE_RULE_IDS: ReadonlySet<string> = new Set([
  'handoff_promise_without_handoff',
  'dangling_reply_promise',
  'application_record_update_promise',
]);

/** 跟进承诺：让同事确认 / 我再核实下 / 稍等 / 稍后告诉你。 */
const FOLLOW_UP_PROMISE_PATTERN =
  /(?:同事|负责人|专员|经理|人工)[^。！？!?\n]{0,8}(?:确认|联系|处理|跟进|核实)|我(?:这边)?(?:再|去|先)?(?:确认|核实|问)(?:一)?下|稍等|稍后[^。！？!?\n]{0,6}(?:回复|告诉|联系|通知|确认)/u;

/** 确认语：把"待办"说成"已定"。 */
const AFFIRMATION_PATTERN =
  /没问题|可以的|没得问题|安排好了|已(?:经)?(?:改|调整|安排|确认)好|就这么定|定好了/u;

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
  const zeroEvidenceContext =
    context?.jobEvidenceAvailable === false ||
    (context?.triggeredRuleIds ?? []).some((id) => ZERO_EVIDENCE_RULE_IDS.has(id));
  const removesUngroundedJobClaims =
    zeroEvidenceContext &&
    firstJobFacts >= 2 &&
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

  // commitment_upgraded：与上一条方向相反，是删承诺删过了头。
  // badcase 2026-08-06 chat 6a1e42c5（trace …_1785977561594）：候选人要把面试从 15:00
  // 改到 15:30，precheck 已返回在途工单 455384 并点名"改时间用
  // duliday_modify_interview_time"，模型一个工具没调，首版写「让同事帮你确认下能不能改，
  // 稍等」→ 守卫正确命中 handoff_promise_without_handoff(P0)。repair 的 suggestion 白纸黑字
  // 写了"严禁新增本轮工具结果之外的事实（面试时间也算）"，rewrite 却产出「你说的15:30这个
  // 时间没问题」，二审 pass 后投递——首版只是"还没定"，修复版变成"已经定了"。工单至今仍是
  // 15:00，候选人会按 15:30 到店。
  //
  // 首版承诺被删是修对了，问题在于用确认语填了坑。只在承诺类规则触发的轮次判定，
  // 且首版本身不含确认语（首版就说"没问题"是另一个问题，交硬规则）。
  const promiseRuleTriggered = (context?.triggeredRuleIds ?? []).some((id) =>
    PROMISE_RULE_IDS.has(id),
  );
  if (
    promiseRuleTriggered &&
    FOLLOW_UP_PROMISE_PATTERN.test(first) &&
    !FOLLOW_UP_PROMISE_PATTERN.test(revised) &&
    !AFFIRMATION_PATTERN.test(first) &&
    AFFIRMATION_PATTERN.test(revised)
  ) {
    return 'commitment_upgraded';
  }

  return null;
}
