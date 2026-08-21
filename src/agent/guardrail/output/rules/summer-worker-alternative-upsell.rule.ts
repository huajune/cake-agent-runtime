import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { decideLaborFormIntent } from '@resolution/labor-form';
import { TOOL_ERROR_TYPES } from '@tools/shared/tool-error-types';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/** 候选人明确找暑假工后，禁止 Agent 跨轮主动劝转其他用工形式。 */
const ALTERNATIVE_LABOR_FORM = '(?:普通兼职|常规兼职|长期兼职|长期工|小时工|全职)';

const ALTERNATIVE_UPSELL_PATTERNS = [
  new RegExp(
    `(?:要不要|是否|愿不愿意|愿意|可以|能不能|能接受|考虑|看看|看下|推荐|改做|转做|试试)[^。！？\\n]{0,18}${ALTERNATIVE_LABOR_FORM}`,
  ),
  new RegExp(
    `${ALTERNATIVE_LABOR_FORM}[^。！？\\n]{0,18}(?:要不要|是否|愿不愿意|愿意|可以|能接受|考虑|看看|看下|推荐|吗|呢)`,
  ),
  new RegExp(
    `(?:不过|但是|另外|或者|也)[^。！？\\n]{0,10}(?:还有|有)?[^。！？\\n]{0,8}${ALTERNATIVE_LABOR_FORM}`,
  ),
];

/** 解释先前推荐口径不等于本轮主动劝转其它用工形式。 */
const HISTORICAL_RECOMMENDATION_EXPLANATION = new RegExp(
  `(?:之前|此前|先前|前面|刚才|原来)[^。！？\n]{0,16}(?:推荐|介绍)[^。！？\n]{0,12}(?:是|按|属于)[^。！？\n]{0,8}${ALTERNATIVE_LABOR_FORM}(?:走的|岗位|类型)?`,
);

function containsActionableAlternativeUpsell(text: string): boolean {
  return text
    .split(/(?<=[。！？\n])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter((sentence) => !HISTORICAL_RECOMMENDATION_EXPLANATION.test(sentence))
    .some((sentence) => ALTERNATIVE_UPSELL_PATTERNS.some((pattern) => pattern.test(sentence)));
}

const USER_REJECTS_ALTERNATIVES =
  /(?:不考虑|不要|不找|不接受|不可以|不能做)[^。！？\n]{0,10}(?:普通兼职|常规兼职|长期兼职|长期工|小时工|全职)|只(?:要|找|考虑)暑假工/;
const USER_ACCEPTS_ALTERNATIVES = [
  /(?:普通兼职|常规兼职|长期兼职|长期工|小时工|全职)[^。！？\n]{0,12}(?:也可以|都可以|可以考虑|能做|接受|也行|都行|没问题|有吗|有没有|看看)/,
  /(?:找|看看|考虑|接受|可以做|能做)[^。！？\n]{0,12}(?:普通兼职|常规兼职|长期兼职|长期工|小时工|全职)/,
];

function hasSummerWorkerEmptyResult(toolCalls: AgentToolCall[]): boolean {
  return [...toolCalls].reverse().some((call) => {
    if (call.toolName !== 'duliday_job_list') return false;
    const result = asRecord(call.result);
    if (result?.errorType !== TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY) return false;
    const queryMeta = asRecord(result.queryMeta);
    const laborFormFilter = asRecord(queryMeta?.laborFormFilter);
    return laborFormFilter?.candidateLaborForm === '暑假工';
  });
}

function candidateExplicitlyAcceptsAlternatives(userMessage: string | undefined): boolean {
  const text = userMessage?.trim() ?? '';
  if (!text || USER_REJECTS_ALTERNATIVES.test(text)) return false;
  return USER_ACCEPTS_ALTERNATIVES.some((pattern) => pattern.test(text));
}

/**
 * 暑假工身份属于第三方而非候选人本人（"我妹妹也可以过去做，只不过她暑假工"）。
 *
 * 本规则的产品意图是"别拿其他用工形式软磨硬泡一个明确要暑假工的人"；主体是他人时
 * 这层保护不适用——候选人自己谈的仍是常规岗位，删掉本人向的内容才是伤害。
 * 2026-07-30 审计 P1-5 实例 …_1785209582843：候选人问"需要多少人 + 妹妹是暑假工"，
 * 规则命中后反馈强制"只输出一句无岗答复"，两个提问与本人在谈的前厅岗位线索全被抹掉。
 */
const THIRD_PARTY_REFERENT =
  '(?:妹妹|弟弟|姐姐|哥哥|朋友|同学|同事|亲戚|孩子|儿子|女儿|侄女|侄子|表妹|表弟|表姐|表哥|老乡)';
const SUMMER_INTENT_BELONGS_TO_THIRD_PARTY = [
  new RegExp(`${THIRD_PARTY_REFERENT}[^。！？\\n]{0,20}暑假工`),
  new RegExp(`暑假工[^。！？\\n]{0,12}${THIRD_PARTY_REFERENT}`),
];

function summerIntentBelongsToThirdParty(userMessage: string | undefined): boolean {
  const text = userMessage?.trim() ?? '';
  if (!text) return false;
  return SUMMER_INTENT_BELONGS_TO_THIRD_PARTY.some((pattern) => pattern.test(text));
}

function hasActiveSummerWorkerIntent(recentUserTexts: string[] | undefined): boolean {
  if (!recentUserTexts?.length) return false;

  let summerIntentActive = false;
  for (const text of recentUserTexts) {
    const decision = decideLaborFormIntent(text);
    if (decision.kind === 'set') {
      summerIntentActive = decision.value === '暑假工';
    } else if (decision.kind === 'clear' && decision.clearedValues.includes('暑假工')) {
      summerIntentActive = false;
    }
  }
  return summerIntentActive;
}

export function detectSummerWorkerAlternativeUpsell(
  text: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
  recentUserTexts?: string[],
): RuleContradiction | null {
  if (!hasSummerWorkerEmptyResult(toolCalls) && !hasActiveSummerWorkerIntent(recentUserTexts)) {
    return null;
  }
  if (candidateExplicitlyAcceptsAlternatives(userMessage)) return null;
  if (summerIntentBelongsToThirdParty(userMessage)) return null;
  if (!containsActionableAlternativeUpsell(text)) return null;

  return {
    ruleId: 'summer_worker_alternative_upsell',
    label:
      '本轮查岗已确认没有匹配的暑假工岗位，但回复仍在主动劝转普通兼职、小时工、全职或长期兼职；必须直接告知暑假工无岗并结束本轮',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
