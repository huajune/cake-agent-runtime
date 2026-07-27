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
  // "转人工"式承诺（badcase chat 6a5f4549："我帮你转人工核实下具体原因"当轮没落
  // handoff，下一轮才补）。措辞本身另由 human_service_phrase_leak(revise) 治理人设
  // 露馅；本词形管的是承诺与动作对账，两规则叠加时按更重的 replan 收敛。
  /(?:帮|给)你转(?:接)?人工|转(?:接)?人工[^。！？\n]{0,16}(?:核实|确认|处理|跟进|登记|申请)/,
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
    // 2026-07-27 发牌收尾：replan → revise（评估文档 §2.2/§2.4）。replan 作为修复
    // 机制已整体退役；本规则检测是过程判据（承诺词形+dispatched 对账）、rewrite 下
    // 修法唯一（删除完成时态承诺、只陈述已确认事实），符合白名单准入三条件，且 P0
    // 收敛保证 rewrite 失败即 block——假承诺不会出门。"真正补执行 request_handoff"
    // 的保文补参式修复是条件项（评估文档 §2.4），届时走两步拆解不回 replan。
    action: GUARDRAIL_ACTION.REVISE,
  };
}
