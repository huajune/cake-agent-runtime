import type { AgentToolCall, GeneratorRunResult } from '../generator/generator.types';
import type { GuardrailTurnTrace, OutputResolution } from '@shared-types/guardrail.contract';
import {
  blocksReplay,
  isHandoffGateRejectedToolCall,
  isShortCircuitedToolCall,
} from '../generator/tool-call-analysis';
import type { OutputGuardDecision } from '../guardrail/output/output-guardrail.service';
import { OutboundReplySanitizer } from '../guardrail/output/sanitizer/outbound-reply-sanitizer';
import { STALE_INPUT_REASON_CODE } from '@tools/shared/tool-error-types';
import { buildHandoffIdempotencyKey } from './handoff-idempotency';
import { buildPreHandoffReceipt } from './handoff-receipt';
import {
  buildPromiseReconciliationSideEffect,
  detectUnreconciledHandoffPromise,
} from './promise-reconciliation';
import type { SessionRef, TurnOutcome } from './agent-runner.types';
import type {
  GeneralHandoffSideEffectIntent,
  TurnSideEffectIntent,
} from './turn-side-effect.types';

/** 分类时可选的回合上下文：候选人当轮原话（承诺对账落底账用），runner 从入站请求透传。 */
export interface ReviewedTurnContext {
  userMessage?: string;
}

/** 已审生成结果的最小投入：生成结果 + 出站裁决（runner.invokeReviewed 的产物子集）。 */
export type ReviewedResultLike = GeneratorRunResult & {
  outputDecision: OutputGuardDecision;
  resolution: OutputResolution;
  /** 是否采用了修复后的生成结果。 */
  revised: boolean;
  /** 出站守卫全程 trace（invokeReviewed 产物）；守卫未运行（短路/空文本）时为空。 */
  guardrailTrace?: GuardrailTurnTrace;
};

/**
 * 守卫直达静默中"模型本意就是不回复"的理由码：元叙述旁白、skip_reply 参数信封。
 * 二者语义等效 skip_reply——最终处置 `skipped`、保留已有工具意图、不派守卫介入副作用。
 * 推理/工具残文不在此列（无正文可依只能转人工）。
 */
export const INTENTIONAL_SILENCE_REASON_CODES: ReadonlySet<string> = new Set([
  'meta_narration_silenced',
  'skip_intent_envelope_silenced',
]);

export function isIntentionalGuardSilence(resolution: OutputResolution): boolean {
  return (
    resolution.outcome === 'skipped' &&
    resolution.reasonCode !== undefined &&
    INTENTIONAL_SILENCE_REASON_CODES.has(resolution.reasonCode.split('|')[0])
  );
}

/** 对齐审查后的处置与已发生的工具终态；归档和渠道分类共用，不执行副作用。 */
export function resolveReviewedResolution(
  result: Pick<GeneratorRunResult, 'text' | 'toolCalls'>,
  resolution: OutputResolution,
): OutputResolution {
  if (resolution.outcome === 'handoff' || isIntentionalGuardSilence(resolution)) {
    return resolution;
  }
  const toolCalls = result.toolCalls ?? [];
  const handoffCall =
    toolCalls.find(isCommittedRequestHandoffCall) ?? toolCalls.find(isHandoffGateRejectedToolCall);
  if (handoffCall) {
    return {
      ...resolution,
      outcome: 'handoff',
      source: 'agent_tool',
      reasonCode: resolveToolHandoffReasonCode(handoffCall),
    };
  }
  if (
    toolCalls.some(isShortCircuitedToolCall) ||
    !OutboundReplySanitizer.sanitize(result.text ?? '').trim()
  ) {
    return { ...resolution, outcome: 'skipped' };
  }
  return { ...resolution, outcome: 'reply' };
}

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
    return result?.staleInput === true && result?.reasonCode === STALE_INPUT_REASON_CODE;
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

/** 归档与终态使用同一工具转人工原因，避免把已有业务归因记为未知守卫失败。 */
function resolveToolHandoffReasonCode(call: AgentToolCall): string {
  const args = call.args as { reasonCode?: unknown } | undefined;
  const result = call.result as { reasonCode?: unknown } | undefined;
  return (
    (typeof args?.reasonCode === 'string' && args.reasonCode) ||
    (typeof result?.reasonCode === 'string' && result.reasonCode) ||
    'other'
  );
}

/**
 * 把一次「已审生成」分类成渠道无关的 {@link TurnOutcome}（§7）。
 *
 * 纯函数、无副作用：把主 Runner 的被动入站生成结果收敛为统一终态。
 *
 * 优先级：Runner 出站处置 → 转人工（committed request_handoff / booking 溯源 gate /
 * modify 工单归属 gate hard-reject）→
 * 沉默（短路 / 空文本）→ 可投递回复。
 */
export function classifyReviewedOutcome(
  result: ReviewedResultLike,
  sessionRef: SessionRef,
  messageId?: string,
  turnContext?: ReviewedTurnContext,
): TurnOutcome {
  const toolCalls = result.toolCalls ?? [];
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
    finalOutcome: result.resolution.outcome,
    riskLevel: result.outputDecision.riskLevel,
    ruleIds: result.outputDecision.ruleIds,
    blockedRuleIds: result.outputDecision.blockedRuleIds,
    reasonCode: result.resolution.reasonCode,
    revised: result.revised,
  };

  // Runner 已完成有界修复与放行判断；这里仅把处置投影成渠道可提交的回合结果。
  if (
    (result.resolution.outcome === 'handoff' && result.resolution.source !== 'agent_tool') ||
    isIntentionalGuardSilence(result.resolution)
  ) {
    const ruleBlocked = result.outputDecision.blockedRuleIds.length > 0;
    const ruleIds = ruleBlocked
      ? result.outputDecision.blockedRuleIds
      : [result.resolution.reasonCode ?? 'output_review_failed'];
    const turnId = messageId ?? sessionRef.sessionId;
    // 有意静默收敛（meta_narration_silenced / skip_intent_envelope_silenced）：模型本意就是本轮沉默，语义上等效
    // skip_reply，不派 general_handoff——该副作用会暂停托管 + 飞书告警，而此场景
    // 多为真人经理已在沟通（用户裁定：真人插话不自动暂停托管），且候选人下一轮
    // 的新诉求仍应由 Agent 正常接管。守卫档案照常落库，不丢观测。
    const intentionalSilence = result.resolution.outcome === 'skipped';
    const guardHandoff = intentionalSilence
      ? undefined
      : buildOutputGuardHandoffSideEffect({
          sessionRef,
          turnId,
          ruleBlocked,
          reasonCode: result.resolution.reasonCode ?? ruleIds.join(','),
          replyPreview: text,
        });
    return {
      kind: intentionalSilence ? 'skipped' : 'handoff',
      toolCalls,
      runTurnEnd,
      ...metadata,
      sideEffects: guardHandoff ? [...toolSideEffects, guardHandoff] : toolSideEffects,
      handoff: guardHandoff
        ? {
            source: 'output_guardrail',
            reasonCode: guardHandoff.reasonCode,
            reason: guardHandoff.reason,
            idempotencyKey: guardHandoff.idempotencyKey,
          }
        : undefined,
      guardrail: {
        phase: 'outbound',
        source: 'output_guardrail',
        ruleIds,
        reasonCode: result.resolution.reasonCode,
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
    const reasonCode = resolveToolHandoffReasonCode(handoffCall);
    const turnId = messageId ?? sessionRef.sessionId;
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
    // 同轮已提交的报名/改约/取消结果：request_handoff 短路会让候选人什么都收不到，
    // 渠道须在暂停前先投递这段确定性回执（PRD R5.1 第 3 条）。闸门拒绝不算已提交。
    const preHandoffReceipt =
      handoffCall.toolName === 'request_handoff' ? buildPreHandoffReceipt(toolCalls) : undefined;
    return {
      kind: 'handoff',
      toolCalls,
      runTurnEnd,
      ...metadata,
      ...(preHandoffReceipt ? { preHandoffReceipt } : {}),
      sideEffects: [
        handoffToolSideEffect
          ? { ...handoffToolSideEffect, idempotencyKey }
          : fallbackHandoffSideEffect,
      ],
      handoff: {
        source: 'agent_tool',
        reasonCode,
        reason: typeof args?.reason === 'string' ? args.reason : undefined,
        sourceToolCall: handoffCall.toolName,
        idempotencyKey,
        alreadyDispatched,
      },
      outputGuardrail: { ...outputGuardrail, finalOutcome: 'handoff' },
    };
  }

  const shortCircuited = toolCalls.some(isShortCircuitedToolCall);
  if (shortCircuited || text.length === 0) {
    return {
      kind: 'skipped',
      toolCalls,
      runTurnEnd,
      ...metadata,
      sideEffects: toolSideEffects,
      outputGuardrail: { ...outputGuardrail, finalOutcome: 'skipped' },
    };
  }

  // 第一人称明确承诺由同事/负责人跟进，但工具尚未执行时，在终态直接补人工介入。
  // 这属于 side-effect/result reconciliation，不进入 Output Guardrail 规则目录。
  // 结构化：承诺原句 + 候选人原话 + 焦点岗位/工单/阶段 + 按触发工具给码（promise-reconciliation.ts）。
  const promisedText = detectUnreconciledHandoffPromise(text, toolCalls);
  const promiseReconciliation = promisedText
    ? buildPromiseReconciliationSideEffect({
        sessionRef,
        turnId: messageId ?? sessionRef.sessionId,
        promisedText,
        toolCalls,
        userMessage: turnContext?.userMessage,
        focusJobId: resolveFocusJobId(result),
        stage: result.memorySnapshot?.currentStage ?? null,
        resolvedWorkOrderId: result.turnLedger?.jobs.resolvedWorkOrderId ?? null,
      })
    : undefined;

  return {
    kind: 'reply',
    reply: { text },
    toolCalls,
    runTurnEnd,
    ...metadata,
    sideEffects: promiseReconciliation
      ? [...toolSideEffects, promiseReconciliation]
      : toolSideEffects,
    outputGuardrail,
  };
}

/** 承诺对账落底账用的焦点岗位：工具确权焦点 → prep 焦点 → 记忆快照焦点。 */
function resolveFocusJobId(result: ReviewedResultLike): number | null {
  const jobs = result.turnLedger?.jobs;
  return (
    jobs?.attestedFocusJob?.jobId ??
    jobs?.currentFocusJob?.jobId ??
    result.memorySnapshot?.currentFocusJob?.jobId ??
    null
  );
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
}): GeneralHandoffSideEffectIntent & { idempotencyKey: string } {
  const guardType = params.ruleBlocked ? 'rule 档' : '非 rule 档';
  const reason = `出站守卫拦截（${guardType}）：${params.reasonCode}`;
  return {
    kind: 'general_handoff',
    source: 'output_guardrail',
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
