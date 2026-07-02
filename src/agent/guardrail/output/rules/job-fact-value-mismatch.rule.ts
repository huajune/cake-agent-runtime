import type { AgentToolCall } from '@agent/agent-run.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
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

const NEGATION_PATTERN = /不是|不算|没有|不用|无需|不需要|并非|别的|错/;
const QUESTION_PATTERN = /[？?]|[吗呢么]\s*[。！~]*\s*$/;

/**
 * 拼出本轮岗位事实的 ground truth 文本（markdown + rawData JSON）。
 * 结果不可用（空/错误）时返回 null，调用方跳过检查。
 */
function readJobFactGroundTruth(toolCalls: AgentToolCall[]): string | null {
  const call = readLatestJobListCall(toolCalls);
  if (!call?.result) return null;
  if (call.resultCount === 0) return null;
  if (call.status === 'error' || call.status === 'empty') return null;
  const record = call.result as Record<string, unknown>;
  const markdown = typeof record.markdown === 'string' ? record.markdown : '';
  const rawData = record.rawData ? safeStringify(record.rawData) : '';
  const combined = `${markdown}\n${rawData}`.trim();
  return combined || null;
}

function readLatestJobListCall(toolCalls: AgentToolCall[]): AgentToolCall | null {
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (toolCalls[i]?.toolName === 'duliday_job_list') return toolCalls[i];
  }
  return null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** 切句：疑问/否定判定按句子粒度做，避免整段误杀。疑问句被 ？切开后靠句尾 吗/呢/么 兜底识别。 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[？?])|[。！!\n；;]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 该句是否构成对 pattern 的"声称"（非疑问、非否定）。 */
function assertsPattern(sentence: string, pattern: RegExp): boolean {
  if (!pattern.test(sentence)) return false;
  if (QUESTION_PATTERN.test(sentence)) return false;
  if (NEGATION_PATTERN.test(sentence)) return false;
  return true;
}

function textAssertsPattern(text: string, pattern: RegExp): boolean {
  return splitSentences(text).some((sentence) => assertsPattern(sentence, pattern));
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

  const claimsEarly = textAssertsPattern(text, EARLY_SHIFT_PATTERN);
  const claimsLate = textAssertsPattern(text, LATE_SHIFT_PATTERN);
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
  for (const match of truth.matchAll(/\d+(?:\.\d+)?/g)) {
    truthNumbers.add(normalizeNumberToken(match[0]));
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
    if (!textAssertsPattern(text, group.claim)) continue;
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
