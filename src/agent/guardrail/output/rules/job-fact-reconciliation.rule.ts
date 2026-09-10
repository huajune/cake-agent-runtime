import { createOutputRuleFinding } from '../output-rule-catalog';
import type { AgentToolCall } from '@agent/generator/generator.types';
import type { RuleContradiction } from '../output-rule.types';
import { QUANTIFIED_JOB_FACT_PATTERN } from './job-fact-signals.util';

/**
 * 岗位事实 ↔ 查询动作对账（零工具轮的两种假事实）。
 *
 * 背景（badcase 5j1mbgi8 / kwxk74gn / kb629uko）：模型在本轮没有调用任何查岗工具的情况下，
 * 要么宣称"帮你查了下 / 系统里没查到"，要么直接报出会话里从未出现过的门店薪资/距离。
 * 单轮 requiredTool 判据会误伤合法的跨轮复述，所以两条规则各自只取一个高置信形态：
 *
 * 两条都是 REPLAN 档：问题不在文案而在"该发生的查询没发生"，文本重写修不出来，
 * runner 用相同参数重进一次 generator（见 output-rule.types GuardrailRuleAction）。
 *
 * - `job_query_claim_without_query`（REPLAN）：回复用**完成时态**宣称本轮查过（"帮你查了下""没查到"
 *   "系统里暂时没有"），而本轮零查岗/预检/定位工具。"刚才/之前/上次查的"这类回指历史的说法不算。
 * - `job_fact_without_provenance`（REPLAN）：回复出现量化岗位事实（元/时·天·月、km、HH:MM-HH:MM）、
 *   本轮零查岗工具，且该数字在会话内任何一条历史助手消息里都没出现过——既不是本轮工具给的，
 *   也不是复述自己说过的话。回指历史（"刚才那家/上面那个"）的句子豁免。
 */
// 「看了下」泛用（看健康证/看定位），只有后面跟岗位类宾语才算查岗宣称；「查/搜了下」本身就是查岗动作。
const QUERY_DONE_CLAIM_PATTERN =
  /(?:帮你|给你|替你|我)(?:重新|再|又)?(?:查|搜)(?:了(?:一)?下|了下|到了|过了)|(?:帮你|给你|替你|我)(?:重新|再|又)?看(?:了(?:一)?下|了下)(?!你)[^。！？!?\n]{0,14}(?:岗位|门店|工作|兼职|职位|附近|系统)|(?:系统|平台|后台)(?:里|上)?(?:目前|暂时|现在)?(?:没(?:有)?|无)(?:查到|找到|看到|搜到)|(?:目前|暂时|现在)?(?:没(?:有)?|未)(?:查到|搜到)[^，。！？!?\n]{0,12}(?:岗位|门店|工作|兼职|职位)/u;

const HISTORY_REFERENCE_PATTERN = /刚才|刚刚|之前|上次|上回|前面|上面|早上|昨天|先前|开始/u;

/** 本轮任一“查过系统”的工具（查岗/预检/定位/工单三件套）都算真实查询，规则只盯零工具轮。 */
const JOB_QUERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'duliday_job_list',
  'duliday_interview_precheck',
  'geocode',
  'duliday_interview_booking',
  'duliday_cancel_work_order',
  'duliday_modify_interview_time',
]);

/** 量化岗位事实：与 repair 回归闸共用 job-fact-signals 的唯一定义。 */
const QUANTIFIED_FACT_PATTERN = new RegExp(QUANTIFIED_JOB_FACT_PATTERN.source, 'giu');

function normalizeFact(text: string): string {
  return text
    .replace(/\s+/g, '')
    .replace(/(^|[^\d])(\d)(?=[:：]\d{2})/g, '$10$2')
    .replace(/公里/g, 'km')
    .replace(/KM/g, 'km')
    .replace(/：/g, ':')
    .replace(/[~—至到]/g, '-')
    .replace(/小时/g, '时')
    .replace(/元\/?(时|天|月)/g, '元/$1');
}

function hasJobQueryTool(toolCalls: readonly AgentToolCall[]): boolean {
  return toolCalls.some((call) => JOB_QUERY_TOOL_NAMES.has(call.toolName));
}

function sentenceOf(text: string, index: number): string {
  const start = Math.max(
    text.lastIndexOf('。', index),
    text.lastIndexOf('\n', index),
    text.lastIndexOf('！', index),
    text.lastIndexOf('？', index),
  );
  return text.slice(start + 1, index + 1);
}

export function detectJobQueryClaimWithoutQuery(
  text: string,
  toolCalls: AgentToolCall[] = [],
): RuleContradiction | null {
  if (!text.trim() || hasJobQueryTool(toolCalls)) return null;
  const pattern = new RegExp(QUERY_DONE_CLAIM_PATTERN.source, 'gu');
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 8), match.index);
    if (HISTORY_REFERENCE_PATTERN.test(before)) continue;
    return createOutputRuleFinding(
      'job_query_claim_without_query',
      '回复用完成时态宣称本轮查过岗位（"帮你查了下/没查到/系统里没有"），但本轮没有任何 ' +
        'duliday_job_list / duliday_interview_precheck / geocode 调用——查询从未发生',
    );
  }
  return null;
}

/**
 * @param priorTexts 会话内的历史助手回复 + 候选人消息（含本轮）。候选人自己刚说的数字
 *   （"那个 25 元/时的还在招吗"）被复述回去不是编造。调用方拿不到会话历史时不要调本函数
 *   （无法判出处 ≠ 无出处）。已知残余：同一事实换表述（"下午5点到11点"↔"17:00-23:00"）仍会命中。
 */
export function detectJobFactWithoutProvenance(
  text: string,
  toolCalls: AgentToolCall[] = [],
  priorTexts: readonly string[] = [],
): RuleContradiction | null {
  if (!text.trim() || hasJobQueryTool(toolCalls)) return null;
  const history = normalizeFact(priorTexts.join('\n'));
  const pattern = new RegExp(QUANTIFIED_FACT_PATTERN.source, 'giu');
  const orphanFacts: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const sentence = sentenceOf(text, match.index);
    if (HISTORY_REFERENCE_PATTERN.test(sentence)) continue;
    const fact = normalizeFact(match[0]);
    if (!history.includes(fact)) orphanFacts.push(match[0].trim());
  }
  if (orphanFacts.length === 0) return null;
  return createOutputRuleFinding(
    'job_fact_without_provenance',
    `回复给出岗位量化事实「${orphanFacts.slice(0, 3).join('、')}」，但本轮没有查岗工具调用，` +
      '会话内历史回复也从未出现过这些数字——没有任何来源的岗位事实',
  );
}
