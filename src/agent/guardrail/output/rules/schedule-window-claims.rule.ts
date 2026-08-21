import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { CHINESE_CARDINAL } from '@infra/utils/chinese-numeral.util';
import type { RuleContradiction } from '../output-rule.types';

const SCHEDULE_ASSURANCE_PATTERN =
  /(?:协调|可以|能|可)(?:给你|跟店里|和门店)?(?:排|安排)|一般没问题|不会强制|不用上到|不用做到/u;

const TIME_RANGE_PATTERN =
  /(?<!\d)(\d{1,2})(?::([0-5]\d)|点(?:半)?|时)?\s*(?:-|到|至|~|—|–)\s*(?:次日\s*)?(\d{1,2})(?::([0-5]\d)|点(?:半)?|时)?(?!\d)/gu;

const SENTENCE_BOUNDARY_PATTERN = /[。！？!?\n]+/u;
// 否定语境豁免：修复版如实说"没有 X 班次 / X 排不上"时，X 不算承诺时段
// （trace batch_6a86626bce406a6aee0e0aa0：诚实拒绝复述候选人诉求被二审再拦，fail-open 兜底才没静默）。
const NEGATED_WINDOW_PREFIX_PATTERN =
  /(?:(?:不(?:太)?(?:可以|能(?:够)?)|不可|没法|无法)(?:给你|跟店里|和门店)?(?:排|安排)|没有|暂无|不存在|排不了|排不上|排不开|做不到|给不了|不提供|不开)[^，,；;。！？\n]{0,16}$/u;
const NEGATED_WINDOW_SUFFIX_PATTERN =
  /^[^，,；;。！？\n]{0,20}(?:(?:不(?:太)?(?:可以|能(?:够)?)|不可|没法|无法)(?:给你|跟店里|和门店)?(?:排|安排)|排不了|排不上|排不开|做不了|上不了|没有|不存在|不太匹配|不匹配|对不上|不合适|不行)/u;
const LOCAL_ASSURANCE_NEGATION_PREFIX_PATTERN = /(?:不|不太|没有|暂无|不存在|没法|无法)$/u;
// 复述候选人诉求豁免："如果您只能做7-3"是转述而非承诺；但从句自身带承诺词时不豁免
// （"你说的7-3都有能排的班"仍是违规）。
const CANDIDATE_WINDOW_ECHO_PREFIX_PATTERN =
  /(?:您|你)?(?:说的|提的|想要的|要求的|只能(?:做|上|排|干)?|只(?:做|上|排|干)|想(?:做|上|排)|希望(?:做|上|排))[^，,；;。！？\n]{0,8}$/u;

const WEEKLY_CAP_PATTERNS = [
  /(?:每周|一周|每星期|一星期)[^，。！？；;\n]{0,12}?(?:最多|至多|只能|不超过|只|就)[^，。！？；;\n]{0,8}?([一二两三四五六七1-7])\s*天/gu,
  /(?:每周|一周|每星期|一星期)[^，。！？；;\n]{0,8}?(?:可以|能|可)(?:上|做|出勤|工作)?\s*([一二两三四五六七1-7])\s*天(?:了|左右|以内)?/gu,
] as const;
const WEEKLY_CAP_CLAUSE_BOUNDARY_PATTERN = /[，,。！？；;\n]/u;
const HISTORICAL_CAP_MARKERS = ['以前', '之前', '原来', '过去'] as const;
const CURRENT_CAP_MARKERS = ['现在', '目前', '如今', '当前'] as const;
const WORK_REST_CYCLE_PATTERN = /做\s*([一二两三四五六七1-7])\s*休\s*([一二两三四五六七1-7])/gu;
const CYCLE_CLAUSE_BOUNDARY_PATTERN = /[，,；;]/u;
const POSITIVE_CYCLE_PREFIX_PATTERN =
  /(?:需要|建议|推荐|可以|可|不妨)(?:再|去|优先)?(?:考虑|选择|选|找|看看|采用)?[^，,；;。！？\n]{0,40}$/u;
const POSITIVE_CYCLE_SUFFIX_PATTERN =
  /^[^，,；;。！？\n]{0,24}(?:适合|合适|匹配|可选|可行|可以|能满足)/u;
const NEGATED_CYCLE_PREFIX_PATTERN =
  /(?:不(?:建议|推荐|适合|符合|匹配|满足|可行|该|能)|不要|别|不必|禁止|避免)(?:再|去|优先)?(?:考虑|选择|选|找|看看|采用)?[^，,；;。！？\n]{0,16}$/u;
const NEGATED_CYCLE_SUFFIX_PATTERN =
  /^[^，,；;。！？\n]{0,16}(?:不(?:适合|符合|匹配|满足|可行|建议|推荐)|不能|不行|冲突|对不上|超过|高于|多于)/u;

function parseDayNumber(token: string): number | null {
  const parsed = CHINESE_CARDINAL[token] ?? Number(token);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 7 ? parsed : null;
}

function lastMarkerIndex(text: string, markers: readonly string[]): number {
  return markers.reduce((latest, marker) => Math.max(latest, text.lastIndexOf(marker)), -1);
}

function isInactiveWeeklyCap(text: string, index: number): boolean {
  let clauseStart = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!WEEKLY_CAP_CLAUSE_BOUNDARY_PATTERN.test(text[cursor])) continue;
    clauseStart = cursor + 1;
    break;
  }
  const prefix = text.slice(clauseStart, index);
  if (/(?:不是|并非|不再是)[^，,。！？；;\n]{0,12}$/u.test(prefix)) return true;

  const historicalIndex = lastMarkerIndex(prefix, HISTORICAL_CAP_MARKERS);
  const currentIndex = lastMarkerIndex(prefix, CURRENT_CAP_MARKERS);
  return historicalIndex > currentIndex;
}

function extractLatestWeeklyCap(text: string): number | null {
  const matches: Array<{ index: number; token: string }> = [];
  for (const pattern of WEEKLY_CAP_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      matches.push({ index: match.index ?? 0, token: match[1] });
    }
  }
  matches.sort((left, right) => left.index - right.index);

  let cap: number | null = null;
  for (const match of matches) {
    if (isInactiveWeeklyCap(text, match.index)) continue;
    const parsed = parseDayNumber(match.token);
    if (parsed === null) continue;
    cap = parsed;
  }
  return cap;
}

function resolveActiveWeeklyCap(
  userMessage?: string,
  recentUserTexts: string[] = [],
): number | null {
  const currentCap = extractLatestWeeklyCap(userMessage ?? '');
  if (currentCap !== null) return currentCap;

  for (let index = recentUserTexts.length - 1; index >= 0; index -= 1) {
    const cap = extractLatestWeeklyCap(recentUserTexts[index]);
    if (cap !== null) return cap;
  }
  return null;
}

function findClauseBounds(sentence: string, start: number, end: number): [number, number] {
  let clauseStart = 0;
  for (let index = start - 1; index >= 0; index -= 1) {
    if (!CYCLE_CLAUSE_BOUNDARY_PATTERN.test(sentence[index])) continue;
    clauseStart = index + 1;
    break;
  }

  let clauseEnd = sentence.length;
  for (let index = end; index < sentence.length; index += 1) {
    if (!CYCLE_CLAUSE_BOUNDARY_PATTERN.test(sentence[index])) continue;
    clauseEnd = index;
    break;
  }
  return [clauseStart, clauseEnd];
}

function isPositiveCycleRecommendation(sentence: string, start: number, end: number): boolean {
  const [clauseStart, clauseEnd] = findClauseBounds(sentence, start, end);
  const prefix = sentence.slice(clauseStart, start);
  const suffix = sentence.slice(end, clauseEnd);

  if (NEGATED_CYCLE_PREFIX_PATTERN.test(prefix) || NEGATED_CYCLE_SUFFIX_PATTERN.test(suffix)) {
    return false;
  }
  return POSITIVE_CYCLE_PREFIX_PATTERN.test(prefix) || POSITIVE_CYCLE_SUFFIX_PATTERN.test(suffix);
}

function detectWorkRestCycleVsWeeklyCap(
  replyText: string,
  userMessage?: string,
  recentUserTexts: string[] = [],
): RuleContradiction | null {
  const weeklyCap = resolveActiveWeeklyCap(userMessage, recentUserTexts);
  if (weeklyCap === null) return null;

  const sentences = replyText
    .split(/[。！？!?\n]+/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);

  for (const sentence of sentences) {
    for (const match of sentence.matchAll(WORK_REST_CYCLE_PATTERN)) {
      const start = match.index ?? 0;
      if (!isPositiveCycleRecommendation(sentence, start, start + match[0].length)) continue;

      const workDays = parseDayNumber(match[1]);
      const restDays = parseDayNumber(match[2]);
      if (workDays === null || restDays === null) continue;

      const averageDaysPerWeek = (7 * workDays) / (workDays + restDays);
      if (averageDaysPerWeek <= weeklyCap) continue;

      return {
        ruleId: 'unsupported_schedule_window_claim',
        label:
          `候选人明确每周最多出勤 ${weeklyCap} 天，回复却把“${match[0].replace(/\s+/gu, '')}”作为合适方案；` +
          `该循环平均每周约 ${averageDaysPerWeek.toFixed(1)} 天，超过候选人周频上限`,
        action: GUARDRAIL_ACTION.REVISE,
      };
    }
  }

  return null;
}

function toMinutes(hourText: string, minuteText: string | undefined): number | null {
  const hour = Number(hourText);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;
  const minute = minuteText && /^\d{2}$/.test(minuteText) ? Number(minuteText) : 0;
  if (hour === 24 && minute !== 0) return null;
  return hour * 60 + minute;
}

function extractTimeRanges(text: string): Set<string> {
  const ranges = new Set<string>();
  for (const match of text.matchAll(TIME_RANGE_PATTERN)) {
    const start = toMinutes(match[1], match[2]);
    const end = toMinutes(match[3], match[4]);
    if (start === null || end === null) continue;
    ranges.add(`${start}-${end}`);
  }
  return ranges;
}

function hasAffirmativeScheduleAssurance(text: string): boolean {
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const match = SCHEDULE_ASSURANCE_PATTERN.exec(text.slice(searchFrom));
    if (!match) return false;

    const start = searchFrom + (match.index ?? 0);
    if (!LOCAL_ASSURANCE_NEGATION_PREFIX_PATTERN.test(text.slice(0, start))) return true;
    searchFrom = start + match[0].length;
  }
  return false;
}

function isExemptWindowMention(sentence: string, start: number, end: number): boolean {
  const [clauseStart, clauseEnd] = findClauseBounds(sentence, start, end);
  const prefix = sentence.slice(clauseStart, start);
  const suffix = sentence.slice(end, clauseEnd);
  const prefixNegation = NEGATED_WINDOW_PREFIX_PATTERN.exec(prefix);
  const suffixNegation = NEGATED_WINDOW_SUFFIX_PATTERN.exec(suffix);
  if (
    (prefixNegation && !hasAffirmativeScheduleAssurance(prefixNegation[0])) ||
    (suffixNegation && !hasAffirmativeScheduleAssurance(suffixNegation[0]))
  ) {
    return true;
  }
  const clause = sentence.slice(clauseStart, clauseEnd);
  return (
    CANDIDATE_WINDOW_ECHO_PREFIX_PATTERN.test(prefix) && !SCHEDULE_ASSURANCE_PATTERN.test(clause)
  );
}

// 承诺判定收窄到句子级：gate 词与时段必须同句，且时段所在从句未被否定、
// 也不是对候选人诉求的单纯复述——否则"能排"出现在合法转述句时，
// 其它句子里复述候选人要的时段会被误判成承诺。
function extractClaimedRanges(replyText: string): Set<string> {
  const ranges = new Set<string>();
  for (const sentence of replyText.split(SENTENCE_BOUNDARY_PATTERN)) {
    if (!SCHEDULE_ASSURANCE_PATTERN.test(sentence)) continue;
    for (const match of sentence.matchAll(TIME_RANGE_PATTERN)) {
      const start = match.index ?? 0;
      if (isExemptWindowMention(sentence, start, start + match[0].length)) continue;
      const startMinutes = toMinutes(match[1], match[2]);
      const endMinutes = toMinutes(match[3], match[4]);
      if (startMinutes === null || endMinutes === null) continue;
      ranges.add(`${startMinutes}-${endMinutes}`);
    }
  }
  return ranges;
}

function stringifyResult(result: unknown): string {
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result ?? '');
  } catch {
    return '';
  }
}

/**
 * 岗位工具列出明确班次后，禁止承诺一个工具未列出的自定义时段。
 *
 * 规则刻意收窄到“时间段 + 可协调/没问题”承诺，不拦普通的候选人时间复述，
 * 也不试图恢复已经下线的宽泛 schedule fact 规则。承诺词与时段须同句，
 * 被否定或单纯复述候选人诉求的时段不计——诚实拒绝不匹配班次必须能通过本规则。
 */
export function detectUnsupportedScheduleWindowClaim(
  replyText: string,
  toolCalls: AgentToolCall[],
  currentFocusJobId?: number,
  userMessage?: string,
  recentUserTexts: string[] = [],
): RuleContradiction | null {
  const workRestCycleMismatch = detectWorkRestCycleVsWeeklyCap(
    replyText,
    userMessage,
    recentUserTexts,
  );
  if (workRestCycleMismatch) return workRestCycleMismatch;

  const claimedRanges = extractClaimedRanges(replyText);
  if (claimedRanges.size === 0) return null;

  const relevantCalls = toolCalls.filter((call) => {
    if (call.toolName !== 'duliday_job_list' || call.status === 'error') return false;
    if (!currentFocusJobId) return true;
    const ids = Array.isArray(call.args?.jobIdList) ? call.args.jobIdList : [];
    return ids.some((id) => Number(id) === currentFocusJobId);
  });
  if (relevantCalls.length === 0) return null;

  const supportedRanges = new Set<string>();
  for (const call of relevantCalls) {
    for (const range of extractTimeRanges(stringifyResult(call.result))) supportedRanges.add(range);
  }
  const unsupported = [...claimedRanges].filter((range) => !supportedRanges.has(range));
  if (unsupported.length === 0) return null;

  return {
    ruleId: 'unsupported_schedule_window_claim',
    label:
      '回复承诺可协调的工作时段未出现在当前岗位查询结果中；只能转述工具列出的班次，' +
      '候选人无法满足时应说明需门店确认或改推匹配岗位',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
