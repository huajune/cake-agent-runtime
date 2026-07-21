import type { AgentToolCall } from '@agent/generator/generator.types';
import { GUARDRAIL_ACTION } from '@shared-types/guardrail.contract';
import { asRecord, type RuleContradiction } from '../output-rule.types';

/**
 * “同事/负责人后续处理”是可验证的外部动作承诺，不能只靠一句话成立。
 *
 * 这条规则刻意不拦“具体以门店/同事确认为准”一类边界声明；只有 Agent 明确声称自己
 * 已经或将要联系某个人继续确认、处理、回复时，才要求本轮存在成功 request_handoff。
 */
const HANDOFF_PROMISE_PATTERNS: RegExp[] = [
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?(?:帮你)?(?:让|找|问|联系|反馈给|转给)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,24}(?:确认|核实|处理|跟进|联系|回复|答复)/,
  /我(?:们)?(?:这边)?(?:已经|会|来|先|马上|尽快)?帮你(?:转给|转达给|反馈给|联系)[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)/,
  /稍后[^。！？\n]{0,16}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,16}(?:会|来)?(?:联系|回复|答复|跟进|处理)/,
];

function hasCommittedRequestHandoff(toolCalls: AgentToolCall[]): boolean {
  return toolCalls.some((call) => {
    if (call.toolName !== 'request_handoff') return false;
    return asRecord(call.result)?.dispatched === true;
  });
}

export function detectHandoffPromiseWithoutHandoff(
  content: string,
  toolCalls: AgentToolCall[],
): RuleContradiction | null {
  if (!content || !HANDOFF_PROMISE_PATTERNS.some((pattern) => pattern.test(content))) return null;
  if (hasCommittedRequestHandoff(toolCalls)) return null;

  return {
    ruleId: 'handoff_promise_without_handoff',
    label:
      '回复承诺已让同事/负责人后续确认或联系候选人，但本轮没有成功 request_handoff，属于无真实动作支撑的跟进承诺',
    action: GUARDRAIL_ACTION.REPLAN,
  };
}
