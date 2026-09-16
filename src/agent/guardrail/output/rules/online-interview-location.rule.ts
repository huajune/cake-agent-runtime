import { createOutputRuleFinding } from '../output-rule-catalog';
import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { parseInterviewMethod, requiresStoreVisit } from '@sponge/interview-method';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 线上面试却声称已发面试定位 / 要求到店。
 *
 * AI／视频等线上面试无需到店；此时声称已发面试定位或要求到店，
 * 会让候选人白跑一趟。
 *
 * `send_store_location` 的 `interviewMethod` / `locationNotRequired` 已在工具结果里，
 * 面试方式是海绵四值单选，这个形态**确定性可判**，不需要 LLM。
 *
 * 边界：`destination='store'` 表示候选人明确问的是"工作地点在哪"，此时发门店定位是正确
 * 行为，只要回复没把它说成面试目的地就放行——这是本规则最主要的假阳来源，必须区分。
 */

/**
 * 到店/面试定位声称。
 *
 * 只收"把定位与面试绑定"或"指引到店"的说法；单纯回答门店在哪（候选人问工作地点）
 * 不在此列，由 destination 分支先行豁免。
 */
const INTERVIEW_LOCATION_CLAIM_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  {
    kind: '已发面试定位',
    pattern: /面试(?:的)?(?:定位|位置|地址)[^。！？\n]{0,10}(?:发|给)(?:你|您)/u,
  },
  {
    kind: '指引导航到店',
    pattern: /(?:点开|打开)[^。！？\n]{0,8}(?:就能|可以)?[^。！？\n]{0,6}导航/u,
  },
  { kind: '指引到店面试', pattern: /(?:直接)?(?:去|到)(?:门)?店(?:里|内)?[^。！？\n]{0,6}面试/u },
  {
    kind: '到店走位提示',
    pattern: /(?:门)?店(?:在|位于)[^。！？\n]{0,12}(?:层|楼|号)[^。！？\n]{0,8}别走错/u,
  },
  { kind: '面试当天到店', pattern: /面试当天[^。！？\n]{0,10}(?:到|去)(?:门)?店/u },
];

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 检出「线上面试 + 到店/面试定位声称」。
 *
 * 触发条件：
 * 1. 本轮调过 `send_store_location` 且拿到结果；
 * 2. 该结果表明本次面试**无需到店**（`locationNotRequired=true`，或 `interviewMethod`
 *    是线下面试以外的枚举值）；
 * 3. `destination` 不是 `store`（候选人问工作地点时发门店定位是正确行为）；
 * 4. 回复出现到店或面试定位声称。
 */
export function detectOnlineInterviewLocationClaim(
  replyText: string,
  toolCalls: readonly AgentToolCall[],
): RuleContradiction | null {
  if (!replyText) return null;

  const call = [...toolCalls]
    .reverse()
    .find((item) => item?.toolName === 'send_store_location' && item.result);
  const result = readRecord(call?.result);
  if (!result) return null;

  // 候选人问的是工作地点，不是面试地点——发门店定位本身正确，不在本规则射程内。
  if (result.destination === 'store') return null;

  const interviewMethod = parseInterviewMethod(result.interviewMethod);
  if (requiresStoreVisit(interviewMethod)) return null;

  // 枚举外的方式串（如"线上初筛后线下复试"）不判线上，只认工具明说的 locationNotRequired。
  const noVisitNeeded = result.locationNotRequired === true || interviewMethod !== null;
  if (!noVisitNeeded) return null;

  for (const { kind, pattern } of INTERVIEW_LOCATION_CLAIM_PATTERNS) {
    if (!pattern.test(replyText)) continue;
    const method = interviewMethod ?? '无需到店';
    return createOutputRuleFinding(
      'online_interview_location_claim',
      `本次面试方式为“${method}”、无需到店，回复却出现${kind}` +
        '——候选人会为一场线上面试白跑一趟门店',
    );
  }
  return null;
}
