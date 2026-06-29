import type { AgentToolCall, GeneratorRunResult } from '../generator/generator.types';
import {
  isBookingGateRejectedToolCall,
  isShortCircuitedToolCall,
} from '../generator/tool-call-analysis';
import type { OutputGuardDecision } from '../guardrail/output/output-guardrail.service';
import type { SessionRef, TurnOutcome, TurnTrigger } from './agent-runner.types';

/** 已审生成结果的最小投入：生成结果 + 出站裁决（runner.invokeReviewed 的产物子集）。 */
export type ReviewedResultLike = GeneratorRunResult & { outputDecision: OutputGuardDecision };

/**
 * 是否为「已固化的 request_handoff」——工具内已 dispatch 转人工（短路 或 dispatched:true）。
 * HANDOFF_NO_BOOKING 返回 dispatched:false/shortCircuited:false → 不算固化，按正常回复处理。
 */
export function isCommittedRequestHandoffCall(call: AgentToolCall): boolean {
  if (call.toolName !== 'request_handoff') return false;
  if (isShortCircuitedToolCall(call)) return true;
  const result =
    call.result && typeof call.result === 'object' && !Array.isArray(call.result)
      ? (call.result as Record<string, unknown>)
      : undefined;
  return result?.dispatched === true;
}

/**
 * 把一次「已审生成」分类成渠道无关的 {@link TurnOutcome}（§7）。
 *
 * 纯函数、无副作用：runner 的 `runTurn`（主动复聊）与 WeCom 被动入站链路共享同一处分类逻辑，
 * 保证「同样的生成结果 → 同样的终态判定」，让 runner 的 outcome 测试同时守护真实入站路径。
 *
 * 优先级：出站 block → 转人工（committed request_handoff / booking gate hard-reject）→
 * 沉默（短路 / 空文本）→ 可投递回复。
 */
export function classifyReviewedOutcome(
  result: ReviewedResultLike,
  trigger: TurnTrigger,
  sessionRef: SessionRef,
  messageId?: string,
): TurnOutcome {
  const toolCalls = result.toolCalls ?? [];
  const scenarioCode = trigger.kind === 'proactive' ? trigger.scenarioCode : undefined;

  // 出站守卫 block（rule 硬拦 / llm 严重违规 / 降级）：不投递、记观测即可。
  if (result.outputDecision.decision === 'block') {
    return { kind: 'blocked', toolCalls, scenarioCode };
  }

  const runTurnEnd = result.runTurnEnd;

  // handoff：request_handoff（工具内已 dispatch）或 booking gate hard-reject（outcome 层 dispatch）
  const requestHandoff = toolCalls.find(isCommittedRequestHandoffCall);
  const bookingGateReject = toolCalls.find(isBookingGateRejectedToolCall);
  const handoffCall = requestHandoff ?? bookingGateReject;
  if (handoffCall) {
    const args = handoffCall.args as { reasonCode?: unknown; reason?: unknown } | undefined;
    const callResult = handoffCall.result as { reasonCode?: unknown } | undefined;
    const reasonCode =
      (typeof args?.reasonCode === 'string' && args.reasonCode) ||
      (typeof callResult?.reasonCode === 'string' && callResult.reasonCode) ||
      'other';
    const turnId = messageId ?? scenarioCode ?? sessionRef.sessionId;
    return {
      kind: 'handoff',
      toolCalls,
      scenarioCode,
      runTurnEnd,
      handoff: {
        reasonCode,
        reason: typeof args?.reason === 'string' ? args.reason : undefined,
        sourceToolCall: handoffCall.toolName,
        idempotencyKey: `${sessionRef.sessionId}:handoff:${turnId}`,
        // 迁移期：request_handoff 工具内已 dispatch，outcome 层不再 dispatch
        alreadyDispatched: handoffCall.toolName === 'request_handoff',
      },
    };
  }

  const text = (result.text ?? '').trim();
  const shortCircuited = toolCalls.some(isShortCircuitedToolCall);
  if (shortCircuited || text.length === 0) {
    return { kind: 'skipped', toolCalls, scenarioCode, runTurnEnd };
  }

  return { kind: 'reply', reply: { text }, toolCalls, scenarioCode, runTurnEnd };
}
