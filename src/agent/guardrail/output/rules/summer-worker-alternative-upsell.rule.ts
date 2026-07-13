import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/** 候选人明确找暑假工、工具确认无岗后，禁止 Agent 主动劝转其他用工形式。 */
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

export function detectSummerWorkerAlternativeUpsell(
  text: string,
  toolCalls: AgentToolCall[],
  userMessage?: string,
): RuleContradiction | null {
  if (!hasSummerWorkerEmptyResult(toolCalls)) return null;
  if (candidateExplicitlyAcceptsAlternatives(userMessage)) return null;
  if (!ALTERNATIVE_UPSELL_PATTERNS.some((pattern) => pattern.test(text))) return null;

  return {
    ruleId: 'summer_worker_alternative_upsell',
    label:
      '本轮查岗已确认没有匹配的暑假工岗位，但回复仍在主动劝转普通兼职、小时工、全职或长期兼职；必须直接告知暑假工无岗并结束本轮',
    action: GUARDRAIL_ACTION.REVISE,
  };
}
