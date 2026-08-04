import type { AgentToolCall } from '@shared-types/agent-telemetry.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import type { RuleContradiction } from '../output-rule.types';

/**
 * 线上面试却声称已发面试定位 / 要求到店。
 *
 * 2026-07-30 生产实证（07-31 扫描日报红标，连续第二天复发，当日 4 次）：面试方式是
 * AI 面试／视频面试（无需到店），回复仍说"门店位置我发你了，你点开就能看导航"，
 * 部分还补"门店在负一层，别走错"。会话 `6a6ab32a` 10:24、`6a6af9d4` 15:32 与 15:33
 * （连发两轮）、`6a5dbb50` 20:57；07-29 另有同型 `6a69674e`。
 * **候选人会为一场线上面试白跑一趟门店**，是直接可见的伤害。
 *
 * 语义层早有对应条款（reviewer 提示词「只有 interviewMethod 明确为线下/到店/现场面试时
 * 才允许声称有面试地址」），但语义审查是 shadow，判了也拦不住投递——连续两天复发即是
 * 明证。`send_store_location` 的 `interviewMethod` / `locationNotRequired` 就在工具结果里，
 * 这个形态**确定性可判**，不需要 LLM。
 *
 * 边界：`destination='store'` 表示候选人明确问的是"工作地点在哪"，此时发门店定位是正确
 * 行为，只要回复没把它说成面试目的地就放行——这是本规则最主要的假阳来源，必须区分。
 */

/** 线上面试形态：这些方式下候选人不需要到店。 */
const ONLINE_INTERVIEW_PATTERN = /线上|AI\s*面试|ai\s*面试|视频|电话|远程/u;

/** 明确的线下面试形态；命中即整条规则豁免（到店是正确指引）。 */
const OFFLINE_INTERVIEW_PATTERN = /线下|到店|现场|门店面试/u;

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
 *    命中线上形态且未同时命中线下形态）；
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

  const interviewMethod = typeof result.interviewMethod === 'string' ? result.interviewMethod : '';
  // 线下字样优先：方式串里同时出现"线上初筛/线下复试"时保守放行，交语义审查。
  if (OFFLINE_INTERVIEW_PATTERN.test(interviewMethod)) return null;

  const noVisitNeeded =
    result.locationNotRequired === true || ONLINE_INTERVIEW_PATTERN.test(interviewMethod);
  if (!noVisitNeeded) return null;

  for (const { kind, pattern } of INTERVIEW_LOCATION_CLAIM_PATTERNS) {
    if (!pattern.test(replyText)) continue;
    const method = interviewMethod || '无需到店';
    return {
      ruleId: 'online_interview_location_claim',
      label:
        `本次面试方式为“${method}”、无需到店，回复却出现${kind}` +
        '——候选人会为一场线上面试白跑一趟门店',
      action: GUARDRAIL_ACTION.REVISE,
    };
  }
  return null;
}
