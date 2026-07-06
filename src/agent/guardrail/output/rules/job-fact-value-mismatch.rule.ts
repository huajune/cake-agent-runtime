import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { assertsClaim, splitClaimSentences } from './claim-assertion.util';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 岗位事实"值级"对账规则。
 *
 * 与 job-fact-hallucinations 的分工：
 * - job-fact-hallucinations 管"接地存在性"——回复输出岗位事实时本轮有没有工具依据；
 * - 本文件管"值一致性"——本轮工具明明给了岗位事实，回复却说了相反/不存在的值。
 *   历史 badcase：晚班说成早班（recvkYh95uVU43，还报名成功了）、节假日时薪 54 说成 17
 *   （recvi9UoI6jAiE）、月结说成日结。这类错误 prompt 拦不住，语义档默认又是关的，
 *   值级矛盾必须有确定性兜底。
 *
 * ground truth 说明：
 * - duliday_job_list 默认只返回 markdown（rawData 需显式传），markdown 是 render 层对
 *   raw 字段的忠实渲染，因此把 markdown + rawData(JSON) 拼成"本轮岗位事实文本"做对账；
 * - 多岗位场景按并集语义：回复声称的值只要被任一岗位支持就不算矛盾。
 *
 * 误杀控制：
 * - 只在本轮有可用 job_list 结果时检查（历史承接场景不管，与 salary_fabrication 同口径）；
 * - 疑问句、否定句里的班次/结算词不算"声称"；
 * - 回复同时提到两种极性（如"早班晚班都有"）视为枚举语境，跳过。
 */

const EARLY_SHIFT_PATTERN = /早班|白班/;
const LATE_SHIFT_PATTERN = /晚班|夜班|通宵/;

const SETTLEMENT_GROUPS = [
  { key: '日结', claim: /日结|当日结|当天结/, truth: /日结|当日结|当天结/ },
  { key: '周结', claim: /周结|按周结/, truth: /周结|按周结/ },
  { key: '月结', claim: /月结|按月结/, truth: /月结|次月|按月结/ },
] as const;

// "时薪 20 元 / 每小时20块 / 一小时 20 元" 形态
const HOURLY_SALARY_PREFIX_PATTERN =
  /(?:时薪|每小时|每个小时|一小时|一个小时)[^\d\n]{0,6}(\d+(?:\.\d+)?)\s*(?:元|块)/g;
// "20元/小时 / 20元每小时 / 20块一小时" 形态
const HOURLY_SALARY_SUFFIX_PATTERN =
  /(\d+(?:\.\d+)?)\s*(?:元|块)\s*(?:[/每]|一)\s*(?:个?小时|时(?![间段]))/g;
// ground truth 里的薪资区间："20-25元"、"20~25 元"
const SALARY_RANGE_PATTERN = /(\d+(?:\.\d+)?)\s*[-~—～至]\s*(\d+(?:\.\d+)?)/g;

// 否定/疑问/切句判定已下沉到 claim-assertion.util（承诺类规则共用同一口径）。

/**
 * 结算词的"要求复述"语境：句子是在转述候选人的求职条件（"符合晚班日结要求的岗位"、
 * "想找日结的"），不是在声称某个岗位的结算方式。
 * 上线首日误伤（2026-07-03 repair_exhausted 单）：告别话术"后续有…符合晚班日结要求
 * 的岗位上线，我再同步给你"被当成岗位结算声称连杀两版。
 *
 * "要求/需求"必须锚定候选人第一人称（"你的要求"）才豁免，不能作裸词：
 * "这个岗位要求日结"是在声称岗位结算口径，若与真实数据矛盾正是本规则要拦的
 * 值级矛盾场景（PR #421 review）。
 */
const CURRENT_JOB_SETTLEMENT_ASSERTION_PATTERN =
  /(?:这个|这家|该|当前|本|门店|岗位)[^。！？\n]{0,16}(?:符合|满足|支持|可以|能|是|要求)/;
const SETTLEMENT_REQUIREMENT_ECHO_PATTERN =
  /(?:按你|按您|想找|想做|想要|偏好|(?:你|您)的?(?:要求|需求|条件))[^。！？\n]{0,10}(?:日结|周结|月结|当日结|当天结)|(?:你|您)的?[^。！？\n]{0,8}(?:日结|周结|月结|当日结|当天结)[^。！？\n]{0,4}(?:要求|需求|条件)/;

/** 未来承诺句（"后续有…上线再同步你"）：不构成对当前岗位事实的声称。 */
const FUTURE_PROMISE_PATTERN =
  /(?:后续|以后|之后|回头|到时|等有|一旦有)[^。！？\n]*(?:上线|再(?:同步|通知|告诉|联系|喊|找)|留意|帮你留意)/;

function isSettlementRequirementEcho(sentence: string): boolean {
  if (CURRENT_JOB_SETTLEMENT_ASSERTION_PATTERN.test(sentence)) return false;
  return SETTLEMENT_REQUIREMENT_ECHO_PATTERN.test(sentence);
}

/**
 * 拼出本轮岗位事实的 ground truth 文本（markdown + rawData JSON）。
 * 没有任何可用结果（全空/错误）时返回 null，调用方跳过检查。
 *
 * 合并本轮**全部可用**的 job_list 结果，不只取最后一次：Agent 常见动作链是
 * “近距离查（空）→ 扩面查（有结果）→ 复核查（空）”，只看最后一次会把已接地的
 * 事实误判成矛盾（与 job-fact-hallucinations 的接地口径同源，多岗位并集语义不变）。
 */
function readJobFactGroundTruth(toolCalls: AgentToolCall[]): string | null {
  const parts: string[] = [];
  for (const call of toolCalls) {
    if (call?.toolName !== 'duliday_job_list') continue;
    if (!call.result) continue;
    if (call.resultCount === 0) continue;
    if (call.status === 'error' || call.status === 'empty') continue;
    const record = call.result as Record<string, unknown>;
    const markdown = typeof record.markdown === 'string' ? record.markdown : '';
    const rawData = record.rawData ? safeStringify(record.rawData) : '';
    const combined = `${markdown}\n${rawData}`.trim();
    if (combined) parts.push(combined);
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/**
 * 班次的"需求复述"语境：句子是在转述候选人的班次偏好（"只找白班""不要早班"），
 * 不是在声称某个岗位的班次。生产假阳（2026-07-06 守卫档案 id=39/62）：候选人问
 * "白班没有吗"，Agent 如实回答"只有夜班……要是只找白班，后续有白班岗上线叫你"，
 * "后续有白班岗上线"被当成把岗位说成白班，两版全杀整轮静默。
 */
const SHIFT_REQUIREMENT_ECHO_PATTERN =
  /(?:只找|只做|只考虑|只要|想找|想做|想要|倾向|偏好|接受)[^。！？\n]{0,6}(?:早班|白班|日班|晚班|夜班|通宵)/;

/** 班次声称句过滤：需求复述 / 未来上新承诺不算对当前岗位班次的声称。 */
function textAssertsShiftClaim(text: string, pattern: RegExp): boolean {
  return splitClaimSentences(text).some(
    (sentence) =>
      assertsClaim(sentence, pattern) &&
      !SHIFT_REQUIREMENT_ECHO_PATTERN.test(sentence) &&
      !FUTURE_PROMISE_PATTERN.test(sentence),
  );
}

/**
 * 班次极性对账：本轮岗位数据只有晚/夜班时，回复不得把岗位说成早班/白班（反向同理）。
 */
export function detectJobShiftPolarityMismatch(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const truth = readJobFactGroundTruth(toolCalls);
  if (!truth) return null;

  const claimsEarly = textAssertsShiftClaim(text, EARLY_SHIFT_PATTERN);
  const claimsLate = textAssertsShiftClaim(text, LATE_SHIFT_PATTERN);
  // 同时提两种极性 = 枚举/对比语境（"早晚班都有"），不判
  if (claimsEarly === claimsLate) return null;

  const truthHasEarly = EARLY_SHIFT_PATTERN.test(truth);
  const truthHasLate = LATE_SHIFT_PATTERN.test(truth);

  if (claimsEarly && !truthHasEarly && truthHasLate) {
    return {
      ruleId: 'job_shift_polarity_mismatch',
      label:
        '回复把岗位说成早班/白班，但本轮 duliday_job_list 返回的班次信息只有晚班/夜班（badcase recvkYh95uVU43 晚班说成早班）',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }
  if (claimsLate && !truthHasLate && truthHasEarly) {
    return {
      ruleId: 'job_shift_polarity_mismatch',
      label: '回复把岗位说成晚班/夜班，但本轮 duliday_job_list 返回的班次信息只有早班/白班',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }
  return null;
}

/**
 * 时薪数值对账：回复声称的"时薪 X 元"必须能在本轮岗位数据里找到
 * （精确数字或落在任一薪资区间内）。
 *
 * 判定刻意宽松：数字只要出现在工具输出的任何位置就算支持——宁可漏判，
 * 不把"综合薪资/阶梯薪资换算"误杀掉；完全不存在的数字才是确定的编造。
 */
export function detectHourlySalaryValueMismatch(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const truth = readJobFactGroundTruth(toolCalls);
  if (!truth) return null;
  // 工具输出里没有薪资内容（如 includeJobSalary 关闭）时无从对账，跳过
  if (!/薪|工资/.test(truth)) return null;

  const claimed = new Set<string>();
  for (const pattern of [HOURLY_SALARY_PREFIX_PATTERN, HOURLY_SALARY_SUFFIX_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      claimed.add(match[1]);
    }
  }
  if (claimed.size === 0) return null;

  const truthNumbers = new Set<string>();
  const truthValues: number[] = [];
  for (const match of truth.matchAll(/\d+(?:\.\d+)?/g)) {
    truthNumbers.add(normalizeNumberToken(match[0]));
    const value = Number(match[0]);
    if (Number.isFinite(value)) truthValues.push(value);
  }
  const truthRanges: Array<[number, number]> = [];
  SALARY_RANGE_PATTERN.lastIndex = 0;
  for (const match of truth.matchAll(SALARY_RANGE_PATTERN)) {
    const low = Number(match[1]);
    const high = Number(match[2]);
    if (Number.isFinite(low) && Number.isFinite(high) && low <= high) {
      truthRanges.push([low, high]);
    }
  }

  for (const token of claimed) {
    const normalized = normalizeNumberToken(token);
    if (truthNumbers.has(normalized)) continue;
    const value = Number(normalized);
    if (truthRanges.some(([low, high]) => value >= low && value <= high)) continue;
    // 舍入/取整容差：工具数据 46.38 被口语化成 46 不是编造（生产假阳 2026-07-06
    // 守卫档案 id=4）。四舍五入（差值 ≤0.5）或直接抹零头（trunc）都算同一数值。
    if (truthValues.some((t) => Math.abs(value - t) <= 0.5 || Math.trunc(t) === value)) continue;
    return {
      ruleId: 'hourly_salary_value_mismatch',
      label: `回复声称时薪 ${token} 元，但该数值在本轮 duliday_job_list 返回的岗位数据里不存在（badcase recvi9UoI6jAiE 节假日时薪 54 说成 17）`,
      action: GUARDRAIL_ACTION.REVISE,
    };
  }
  return null;
}

/** "20.0" 与 "20" 归一成同一 token。 */
function normalizeNumberToken(token: string): string {
  const value = Number(token);
  return Number.isFinite(value) ? String(value) : token;
}

/**
 * 结算方式对账：本轮岗位数据写了结算口径时，回复声称的日结/周结/月结必须与之相符。
 */
export function detectSettlementCycleMismatch(
  text: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  const truth = readJobFactGroundTruth(toolCalls);
  if (!truth) return null;
  // 工具输出里没有任何结算口径时无从对账，跳过
  const truthHasAnySettlement = SETTLEMENT_GROUPS.some((group) => group.truth.test(truth));
  if (!truthHasAnySettlement) return null;

  for (const group of SETTLEMENT_GROUPS) {
    const claimingSentences = splitClaimSentences(text).filter(
      (sentence) =>
        assertsClaim(sentence, group.claim) &&
        // 复述候选人要求 / 未来上新承诺不算对当前岗位结算方式的声称
        !isSettlementRequirementEcho(sentence) &&
        !FUTURE_PROMISE_PATTERN.test(sentence),
    );
    if (claimingSentences.length === 0) continue;
    if (group.truth.test(truth)) continue;
    const truthKeys = SETTLEMENT_GROUPS.filter((g) => g.truth.test(truth)).map((g) => g.key);
    return {
      ruleId: 'settlement_cycle_mismatch',
      label: `回复声称"${group.key}"，但本轮 duliday_job_list 返回的岗位结算口径是"${truthKeys.join('/')}"（badcase #15 日结/月结说错）`,
      action: GUARDRAIL_ACTION.REVISE,
    };
  }
  return null;
}
