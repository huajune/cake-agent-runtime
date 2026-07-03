import type { AgentToolCall, GeneratorRunResult } from '../generator/generator.types';
import type { GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import {
  blocksReplay,
  isBookingGateRejectedToolCall,
  isShortCircuitedToolCall,
} from '../generator/tool-call-analysis';
import type { OutputGuardDecision } from '../guardrail/output/output-guardrail.service';
import type { SessionRef, TurnOutcome, TurnTrigger } from './agent-runner.types';
import type {
  GeneralHandoffSideEffectIntent,
  TurnSideEffectIntent,
} from './turn-side-effect.types';

/** 已审生成结果的最小投入：生成结果 + 出站裁决（runner.invokeReviewed 的产物子集）。 */
export type ReviewedResultLike = GeneratorRunResult & {
  outputDecision: OutputGuardDecision;
  /** invokeReviewed 是否触发了 revise 重写（pass 也会携带 false）。 */
  revised: boolean;
  /** 出站守卫全程 trace（invokeReviewed 产物）；守卫未运行（短路/空文本）时为空。 */
  guardrailTrace?: GuardrailTurnTrace;
};

export interface ReplaySkipDecision {
  skip: boolean;
  reasons: string[];
  blockingTools: string[];
}

export function resolveReplaySkipDecision(
  outcome: TurnOutcome | undefined,
  toolCalls: AgentToolCall[] | undefined,
): ReplaySkipDecision {
  const reasons: string[] = [];
  if (outcome && outcome.kind !== 'reply') {
    reasons.push(`outcome:${outcome.kind}`);
  }
  if (outcome?.sideEffects?.some((intent) => !intent.alreadyDispatched)) {
    reasons.push('side_effect');
  }

  const blockingTools = collectReplayBlockingTools(toolCalls);
  for (const toolName of blockingTools) {
    reasons.push(`tool:${toolName}`);
  }

  return { skip: reasons.length > 0, reasons, blockingTools };
}

function collectReplayBlockingTools(toolCalls: AgentToolCall[] | undefined): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const hit = new Set<string>();
  for (const call of toolCalls) {
    if (blocksReplay(call)) {
      hit.add(call.toolName);
    }
  }
  return Array.from(hit);
}

/** 是否为有效 request_handoff：短路或 dispatched:true；HANDOFF_NO_BOOKING 不算。 */
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
  const text = (result.text ?? '').trim();
  const runTurnEnd = result.runTurnEnd;
  const toolSideEffects = collectToolSideEffectIntents(toolCalls);
  const metadata = {
    generatedText: text,
    reasoning: result.reasoning,
    usage: result.usage,
    agentSteps: result.agentSteps,
    memorySnapshot: result.memorySnapshot,
    responseMessages: result.responseMessages,
    guardrailTrace: result.guardrailTrace,
  };
  const outputGuardrail: TurnOutcome['outputGuardrail'] = {
    decision: result.outputDecision.decision,
    riskLevel: result.outputDecision.riskLevel,
    ruleIds: result.outputDecision.ruleIds,
    blockedRuleIds: result.outputDecision.blockedRuleIds,
    reasonCode: result.outputDecision.reasonCode,
    revised: result.revised,
  };

  // 出站守卫 block（rule 硬拦 / llm 严重违规 / 降级）：不投递，并交给人工兜底。
  if (result.outputDecision.decision === 'block') {
    const ruleBlocked = result.outputDecision.blockedRuleIds.length > 0;
    const ruleIds = ruleBlocked
      ? result.outputDecision.blockedRuleIds
      : [result.outputDecision.reasonCode ?? 'output_blocked'];
    const turnId = messageId ?? scenarioCode ?? sessionRef.sessionId;
    return {
      kind: 'guardrail_blocked',
      toolCalls,
      scenarioCode,
      runTurnEnd,
      ...metadata,
      disposition: 'side_effects',
      sideEffects: [
        ...toolSideEffects,
        buildOutputGuardHandoffSideEffect({
          sessionRef,
          turnId,
          ruleBlocked,
          reasonCode: result.outputDecision.reasonCode ?? ruleIds.join(','),
          replyPreview: text,
        }),
      ],
      guardrail: {
        phase: 'outbound',
        source: 'output_guardrail',
        ruleIds,
        reasonCode: result.outputDecision.reasonCode,
        ruleBlocked,
        inspectedText: text,
      },
      outputGuardrail,
    };
  }

  // handoff：request_handoff 或 booking gate hard-reject；副作用统一从 sideEffects 出口执行。
  const requestHandoff = toolCalls.find(isCommittedRequestHandoffCall);
  const bookingGateReject = toolCalls.find(isBookingGateRejectedToolCall);
  const handoffCall = requestHandoff ?? bookingGateReject;
  if (handoffCall) {
    const args = handoffCall.args as { reasonCode?: unknown; reason?: unknown } | undefined;
    const callResult = handoffCall.result as { reasonCode?: unknown } | undefined;
    const handoffToolSideEffect = collectToolSideEffectIntents([handoffCall])[0];
    const reasonCode =
      (typeof args?.reasonCode === 'string' && args.reasonCode) ||
      (typeof callResult?.reasonCode === 'string' && callResult.reasonCode) ||
      'other';
    const turnId = messageId ?? scenarioCode ?? sessionRef.sessionId;
    const alreadyDispatched = handoffCall.toolName === 'request_handoff' && !handoffToolSideEffect;
    const idempotencyKey = `${sessionRef.sessionId}:handoff:${turnId}`;
    const gateReason =
      handoffCall.toolName === 'duliday_interview_booking'
        ? resolveBookingGateReason(handoffCall, reasonCode)
        : undefined;
    const fallbackHandoffSideEffect: GeneralHandoffSideEffectIntent = {
      kind: 'general_handoff',
      source: 'agent_tool',
      alertLabel:
        handoffCall.toolName === 'duliday_interview_booking'
          ? 'Booking runtime guard 拦截'
          : 'request_handoff 转人工',
      reasonCode:
        handoffCall.toolName === 'duliday_interview_booking' ? 'system_blocked' : reasonCode,
      reason: gateReason || (typeof args?.reason === 'string' && args.reason) || '需要人工协助',
      actionAdvice:
        handoffCall.toolName === 'duliday_interview_booking'
          ? '人工确认 jobId 来源与候选人真实意向；必要时手动补录或重新推荐岗位。'
          : undefined,
      idempotencyKey,
      alreadyDispatched,
      recordHandoff: !alreadyDispatched,
    };
    return {
      kind: 'handoff',
      toolCalls,
      scenarioCode,
      runTurnEnd,
      ...metadata,
      sideEffects: [handoffToolSideEffect ?? fallbackHandoffSideEffect],
      handoff: {
        reasonCode,
        reason: typeof args?.reason === 'string' ? args.reason : undefined,
        sourceToolCall: handoffCall.toolName,
        idempotencyKey,
        alreadyDispatched,
      },
      outputGuardrail,
    };
  }

  const shortCircuited = toolCalls.some(isShortCircuitedToolCall);
  if (shortCircuited || text.length === 0) {
    return {
      kind: 'skipped',
      toolCalls,
      scenarioCode,
      runTurnEnd,
      ...metadata,
      sideEffects: toolSideEffects,
      outputGuardrail,
    };
  }

  return {
    kind: 'reply',
    reply: { text },
    toolCalls,
    scenarioCode,
    runTurnEnd,
    ...metadata,
    sideEffects: toolSideEffects,
    outputGuardrail,
  };
}

function collectToolSideEffectIntents(toolCalls: AgentToolCall[]): TurnSideEffectIntent[] {
  const intents: TurnSideEffectIntent[] = [];
  for (const call of toolCalls) {
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as { sideEffect?: unknown; sideEffects?: unknown })
        : undefined;
    const single = normalizeToolSideEffectIntent(result?.sideEffect);
    if (single) intents.push(single);
    if (Array.isArray(result?.sideEffects)) {
      for (const item of result.sideEffects) {
        const intent = normalizeToolSideEffectIntent(item);
        if (intent) intents.push(intent);
      }
    }
  }
  return intents;
}

function normalizeToolSideEffectIntent(value: unknown): TurnSideEffectIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const intent = value as Partial<TurnSideEffectIntent>;
  if (intent.kind === 'conversation_risk') {
    if (!intent.riskType || !intent.riskLabel || !intent.summary || !intent.reason) return null;
    return intent as TurnSideEffectIntent;
  }
  if (intent.kind === 'general_handoff') {
    if (!intent.alertLabel || !intent.reasonCode || !intent.reason) return null;
    return intent as TurnSideEffectIntent;
  }
  return null;
}

function buildOutputGuardHandoffSideEffect(params: {
  sessionRef: SessionRef;
  turnId: string;
  ruleBlocked: boolean;
  reasonCode: string;
  replyPreview: string;
}): GeneralHandoffSideEffectIntent {
  const guardType = params.ruleBlocked ? 'rule 档' : '非 rule 档';
  const reason = `出站守卫拦截（${guardType}）：${params.reasonCode}`;
  return {
    kind: 'general_handoff',
    source: 'agent_tool',
    alertLabel: `出站守卫拦截（${guardType}）`,
    reasonCode: 'system_blocked',
    reason: `${reason}；replyPreview="${params.replyPreview.slice(0, 400)}"`,
    actionAdvice:
      '本轮回复被出站守卫拦截、未发送给候选人。人工核对候选人最近消息与被拦截回复，必要时人工接管回复。',
    idempotencyKey: `${params.sessionRef.sessionId}:handoff:${params.turnId}:output_guard`,
    recordHandoff: true,
  };
}

function resolveBookingGateReason(
  gateCall: AgentToolCall | undefined,
  fallbackReasonCode: string | undefined,
): string {
  const gateResult =
    gateCall?.result && typeof gateCall.result === 'object' && !Array.isArray(gateCall.result)
      ? (gateCall.result as { reasonCode?: unknown; errorType?: unknown; _outcome?: unknown })
      : undefined;
  const gateReasonCode =
    typeof gateResult?.reasonCode === 'string'
      ? gateResult.reasonCode
      : fallbackReasonCode || 'booking_gate_rejected';
  const gateErrorType = typeof gateResult?.errorType === 'string' ? gateResult.errorType : '';
  const gateOutcome = typeof gateResult?._outcome === 'string' ? gateResult._outcome : '';
  return [gateReasonCode, gateErrorType, gateOutcome].filter(Boolean).join(' | ');
}
