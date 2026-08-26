import type { AgentToolCall, GeneratorRunResult } from '../generator/generator.types';
import type { GuardrailTurnTrace } from '@shared-types/guardrail.contract';
import {
  blocksReplay,
  isHandoffGateRejectedToolCall,
  isShortCircuitedToolCall,
} from '../generator/tool-call-analysis';
import type { OutputGuardDecision } from '../guardrail/output/output-guardrail.service';
import { OutboundReplySanitizer } from '../guardrail/output/outbound-reply-sanitizer';
import { buildHandoffIdempotencyKey } from './handoff-idempotency';
import type { SessionRef, TurnOutcome, TurnTrigger } from './agent-runner.types';
import type {
  GeneralHandoffSideEffectIntent,
  TurnSideEffectIntent,
} from './turn-side-effect.types';

const HANDOFF_PROMISE_PATTERNS: readonly RegExp[] = [
  /我(?:们)?(?:这边)?(?:还)?(?:已经|会|来|先|马上|尽快|需要|得|要)?(?:帮你|给你)?(?:(?:让|请|找|问|联系|反馈给|转给|转达给)[^。！？\n]{0,12}|跟|同)(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,20}(?:确认|核实|处理|跟进|联系你|回复你|答复你|安排)/u,
  /我(?:们)?(?:这边)?[^。！？\n]{0,10}(?:帮你|给你)[^。！？\n]{0,12}[，,]\s*(?:让|请)(?:同事|负责人|招聘经理)[^。！？\n]{0,20}(?:确认|核实|处理|跟进|联系你|回复你|答复你|安排)/u,
];
const HANDOFF_BOUNDARY_PATTERN =
  /(?:具体|最终|实际|准确的?)[^。！？\n]{0,8}(?:以|看|按)[^。！？\n]{0,10}(?:同事|负责人|店长|门店|招聘经理|现场|面试时)[^。！？\n]{0,6}(?:确认|沟通|说明|为准|通知)/u;
const NEGATED_HANDOFF_PROMISE_PATTERN =
  /(?:如果|要是|万一|假如)[^。！？\n]{0,20}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:没有?|未|不)/u;

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
  // 不可逆工具在提交前发现候选人有新消息时会主动短路旧回合。这个 skipped outcome
  // 与普通 skip_reply 相反：必须继续读取 pending 并 replay，不能被 outcome/tool 阻断。
  if (hasStaleInputAbort(toolCalls)) {
    return { skip: false, reasons: [], blockingTools: [] };
  }

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

function hasStaleInputAbort(toolCalls: AgentToolCall[] | undefined): boolean {
  return (toolCalls ?? []).some((call) => {
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : undefined;
    return result?.staleInput === true && result?.reasonCode === 'newer_user_input_pending';
  });
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
 * 优先级：出站 block → 转人工（committed request_handoff / booking 溯源 gate /
 * modify 工单归属 gate hard-reject）→
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
  const text = OutboundReplySanitizer.sanitize(result.text ?? '').trim();
  const runTurnEnd = result.runTurnEnd;
  const toolSideEffects = collectToolSideEffectIntents(toolCalls);
  const metadata = {
    generatedText: text,
    reasoning: result.reasoning,
    usage: result.usage,
    agentSteps: result.agentSteps,
    memorySnapshot: result.memorySnapshot,
    responseMessages: sanitizeResponseMessages(result.responseMessages),
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
    // 元叙述旁白收敛（meta_narration_silenced）：模型本意就是本轮沉默，语义上等效
    // skip_reply，不派 general_handoff——该副作用会暂停托管 + 飞书告警，而此场景
    // 多为真人经理已在沟通（用户裁定：真人插话不自动暂停托管），且候选人下一轮
    // 的新诉求仍应由 Agent 正常接管。守卫档案照常落库，不丢观测。
    const intentionalSilence = result.outputDecision.reasonCode === 'meta_narration_silenced';
    return {
      kind: 'guardrail_blocked',
      toolCalls,
      scenarioCode,
      runTurnEnd,
      ...metadata,
      disposition: 'side_effects',
      sideEffects: intentionalSilence
        ? toolSideEffects
        : [
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

  // handoff：request_handoff、booking 溯源 gate 或 modify 工单归属 gate hard-reject；
  // 副作用统一从 sideEffects 出口执行。
  const requestHandoff = toolCalls.find(isCommittedRequestHandoffCall);
  const gateReject = toolCalls.find(isHandoffGateRejectedToolCall);
  const handoffCall = requestHandoff ?? gateReject;
  if (handoffCall) {
    const args = handoffCall.args as
      | { reasonCode?: unknown; reason?: unknown; jobId?: unknown }
      | undefined;
    const callResult = handoffCall.result as
      | {
          reasonCode?: unknown;
          workOrderId?: unknown;
          jobId?: unknown;
          handoffReason?: unknown;
          actionAdvice?: unknown;
          _outcome?: unknown;
        }
      | undefined;
    const collectedToolSideEffect = collectToolSideEffectIntents([handoffCall])[0];
    const handoffToolSideEffect =
      collectedToolSideEffect?.kind === 'general_handoff' ? collectedToolSideEffect : undefined;
    const reasonCode =
      (typeof args?.reasonCode === 'string' && args.reasonCode) ||
      (typeof callResult?.reasonCode === 'string' && callResult.reasonCode) ||
      'other';
    const turnId = messageId ?? scenarioCode ?? sessionRef.sessionId;
    const alreadyDispatched = handoffCall.toolName === 'request_handoff' && !handoffToolSideEffect;
    const idempotencyKey = buildHandoffIdempotencyKey({
      chatId: sessionRef.sessionId,
      turnId,
    });
    const isBookingGate = handoffCall.toolName === 'duliday_interview_booking';
    const isModifyOwnershipGate = handoffCall.toolName === 'duliday_modify_interview_time';
    const gateReason = isBookingGate
      ? resolveBookingGateReason(handoffCall, reasonCode)
      : isModifyOwnershipGate && typeof callResult?.handoffReason === 'string'
        ? callResult.handoffReason
        : undefined;
    const fallbackHandoffSideEffect: GeneralHandoffSideEffectIntent = {
      kind: 'general_handoff',
      source: 'agent_tool',
      alertLabel: isBookingGate
        ? 'Booking runtime guard 拦截'
        : isModifyOwnershipGate
          ? '工单不属于当前微信联系人'
          : 'request_handoff 转人工',
      reasonCode: isBookingGate ? 'system_blocked' : reasonCode,
      reason:
        gateReason ||
        (typeof args?.reason === 'string' && args.reason) ||
        (typeof callResult?._outcome === 'string' && callResult._outcome) ||
        '需要人工协助',
      actionAdvice: isBookingGate
        ? '人工确认 jobId 来源与候选人真实意向；必要时手动补录或重新推荐岗位。'
        : typeof callResult?.actionAdvice === 'string'
          ? callResult.actionAdvice
          : undefined,
      workOrderId: typeof callResult?.workOrderId === 'number' ? callResult.workOrderId : undefined,
      // booking/precheck 闸门拦截时，入参 jobId 就是本轮尝试的岗位，直接落底账供运营定位。
      jobId:
        typeof args?.jobId === 'number'
          ? args.jobId
          : typeof callResult?.jobId === 'number'
            ? callResult.jobId
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
      sideEffects: [
        handoffToolSideEffect
          ? { ...handoffToolSideEffect, idempotencyKey }
          : fallbackHandoffSideEffect,
      ],
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

  // 第一人称明确承诺由同事/负责人跟进，但工具尚未执行时，在终态直接补人工介入。
  // 这属于 side-effect/result reconciliation，不进入 Output Guardrail 规则目录。
  const promiseReconciliation = hasUnreconciledHandoffPromise(text, toolCalls)
    ? buildPromiseReconciliationSideEffect({
        sessionRef,
        turnId: messageId ?? scenarioCode ?? sessionRef.sessionId,
      })
    : undefined;

  return {
    kind: 'reply',
    reply: { text },
    toolCalls,
    scenarioCode,
    runTurnEnd,
    ...metadata,
    sideEffects: promiseReconciliation
      ? [...toolSideEffects, promiseReconciliation]
      : toolSideEffects,
    outputGuardrail,
  };
}

/**
 * handoff 承诺-动作对账的补动作意图。
 *
 * 复用既有 `other` reasonCode，不新开底账分桶：对运营来说这就是一次普通的"需人工跟进"。
 */
function buildPromiseReconciliationSideEffect(params: {
  sessionRef: SessionRef;
  turnId: string;
}): GeneralHandoffSideEffectIntent {
  return {
    kind: 'general_handoff',
    source: 'agent_tool',
    alertLabel: '需人工跟进（已向候选人承诺）',
    reasonCode: 'other',
    reason: '已向候选人承诺会有人来跟进，需要真人接手兑现。',
    actionAdvice:
      '候选人已经收到"会有人来跟进"的承诺。请按承诺内容接手该会话；若判定无需人工，直接恢复托管即可。',
    idempotencyKey: buildHandoffIdempotencyKey({
      chatId: params.sessionRef.sessionId,
      turnId: params.turnId,
    }),
    recordHandoff: true,
  };
}

function hasUnreconciledHandoffPromise(text: string, toolCalls: AgentToolCall[]): boolean {
  if (!text.trim()) return false;
  if (HANDOFF_BOUNDARY_PATTERN.test(text) || NEGATED_HANDOFF_PROMISE_PATTERN.test(text)) {
    return false;
  }
  if (!HANDOFF_PROMISE_PATTERNS.some((pattern) => pattern.test(text))) return false;
  if (toolCalls.some((call) => hasCompletedHandoffAction(call))) return false;
  return !toolCalls.some((call) => {
    const result =
      call.result && typeof call.result === 'object' && !Array.isArray(call.result)
        ? (call.result as Record<string, unknown>)
        : undefined;
    return result?.hostingPaused === true;
  });
}

function hasCompletedHandoffAction(call: AgentToolCall): boolean {
  if (call.toolName === 'request_handoff') return isCommittedRequestHandoffCall(call);
  if (call.toolName !== 'raise_risk_alert') return false;
  const result =
    call.result && typeof call.result === 'object' && !Array.isArray(call.result)
      ? (call.result as Record<string, unknown>)
      : undefined;
  return Boolean(result && result.success !== false && typeof result.errorType !== 'string');
}

function sanitizeResponseMessages(
  responseMessages: Array<Record<string, unknown>> | undefined,
): Array<Record<string, unknown>> | undefined {
  if (!responseMessages) return undefined;

  return responseMessages.map((message) => {
    const next: Record<string, unknown> = { ...message };
    if (Array.isArray(message.parts)) {
      next.parts = message.parts.map((part) => sanitizeTextPart(part));
    }
    if (Array.isArray(message.content)) {
      next.content = message.content.map((part) => sanitizeTextPart(part));
    }
    return next;
  });
}

function sanitizeTextPart(part: unknown): unknown {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  const record = part as Record<string, unknown>;
  if (record.type !== 'text' || typeof record.text !== 'string') return part;
  return { ...record, text: OutboundReplySanitizer.sanitize(record.text) };
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
    idempotencyKey: buildHandoffIdempotencyKey({
      chatId: params.sessionRef.sessionId,
      turnId: params.turnId,
      scope: 'output_guard',
    }),
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
