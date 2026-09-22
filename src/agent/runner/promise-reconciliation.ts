import type { AgentToolCall } from '../generator/generator.types';
import { buildHandoffIdempotencyKey } from './handoff-idempotency';
import type { SessionRef } from './agent-runner.types';
import type { GeneralHandoffSideEffectIntent } from './turn-side-effect.types';

/**
 * 承诺-动作对账（PRD R5.1 第 2 条）。
 *
 * 回复里第一人称承诺「让同事/负责人/店长…确认/跟进」但本轮没有任何转人工动作时，终态补一次
 * 人工介入。此前补动作只写固定模板、原因码一律 other、岗位/工单/阶段全空（28 天 100 条）。
 * 现在：
 * - 命中句按句子粒度提取，完成时陈述（「我跟门店确认过了」）不算承诺；
 * - 原因码按本轮失败的工具给（改约/取消失败 → modify_appointment，报名失败 → 名额满/重复/系统卡住，
 *   拉群失败 → group_invite_failed），没有触发工具才落 other；
 * - reason 带承诺原句与候选人当轮原话，jobId/workOrderId/stage 尽量从本轮上下文取；
 * - 「回复最终未投递不补」由渠道按 origin=promise_reconciliation 过滤（本模块只打标）。
 */

const HANDOFF_PROMISE_PATTERNS: readonly RegExp[] = [
  /我(?:们)?(?:这边)?(?:还)?(?:已经|会|来|先|马上|尽快|需要|得|要)?(?:帮你|给你)?(?:(?:让|请|找|问|联系|反馈给|转给|转达给)[^。！？\n]{0,12}|跟|同)(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,20}(?:确认|核实|处理|跟进|联系你|回复你|答复你|安排)/u,
  /我(?:们)?(?:这边)?[^。！？\n]{0,10}(?:帮你|给你)[^。！？\n]{0,12}[，,]\s*(?:让|请)(?:同事|负责人|招聘经理)[^。！？\n]{0,20}(?:确认|核实|处理|跟进|联系你|回复你|答复你|安排)/u,
];
const HANDOFF_BOUNDARY_PATTERN =
  /(?:具体|最终|实际|准确的?)[^。！？\n]{0,8}(?:以|看|按)[^。！？\n]{0,10}(?:同事|负责人|店长|门店|招聘经理|现场|面试时)[^。！？\n]{0,6}(?:确认|沟通|说明|为准|通知)/u;
const NEGATED_HANDOFF_PROMISE_PATTERN =
  /(?:如果|要是|万一|假如)[^。！？\n]{0,20}(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:没有?|未|不)/u;
/**
 * 完成时陈述：「我跟门店确认过了」「已经和同事核实了」「同事已确认」——动作已经发生，
 * 不是对未来的承诺，补介入只会让运营去兑现一件已经做完的事。
 */
const COMPLETED_HANDOFF_STATEMENT_PATTERN =
  /(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,10}(?:确认|核实|沟通|问|反馈)(?:过|了)|(?:已经?|刚才?|之前|早就)[^。！？\n]{0,8}(?:跟|和|同|向|找|让|请)(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,12}(?:确认|核实|沟通|问|反馈)|(?:同事|负责人|店长|门店|招聘经理)[^。！？\n]{0,6}(?:已确认|已核实|已经确认|已经核实|已沟通|已反馈)/u;

const SENTENCE_SPLIT = /(?<=[。！？!?\n])/u;
const MAX_QUOTE_LENGTH = 200;

/** 返回命中的承诺原句；无未兑现承诺时返回 undefined。 */
export function detectUnreconciledHandoffPromise(
  text: string,
  toolCalls: AgentToolCall[],
): string | undefined {
  if (!text.trim()) return undefined;
  if (HANDOFF_BOUNDARY_PATTERN.test(text) || NEGATED_HANDOFF_PROMISE_PATTERN.test(text)) {
    return undefined;
  }
  const promised = text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .find(
      (sentence) =>
        sentence.length > 0 &&
        HANDOFF_PROMISE_PATTERNS.some((pattern) => pattern.test(sentence)) &&
        !COMPLETED_HANDOFF_STATEMENT_PATTERN.test(sentence),
    );
  if (!promised) return undefined;
  if (toolCalls.some((call) => hasCompletedHandoffAction(call))) return undefined;
  if (toolCalls.some((call) => asRecord(call.result)?.hostingPaused === true)) return undefined;
  return promised;
}

export interface PromiseReconciliationContext {
  sessionRef: SessionRef;
  turnId: string;
  promisedText: string;
  toolCalls: AgentToolCall[];
  userMessage?: string;
  focusJobId?: number | null;
  stage?: string | null;
  resolvedWorkOrderId?: number | null;
}

export function buildPromiseReconciliationSideEffect(
  params: PromiseReconciliationContext,
): GeneralHandoffSideEffectIntent {
  const trigger = resolveTriggeringToolFailure(params.toolCalls);
  const promised = truncate(params.promisedText);
  const candidate = truncate(params.userMessage?.trim() ?? '');
  const reasonParts = [`承诺跟进：「${promised}」`];
  if (candidate) reasonParts.push(`候选人原话：「${candidate}」`);
  if (trigger) reasonParts.push(`触发：${trigger.toolName} 失败（${trigger.errorType}）`);
  return {
    kind: 'general_handoff',
    source: 'agent_tool',
    origin: 'promise_reconciliation',
    alertLabel: '需人工跟进（已向候选人承诺）',
    reasonCode: trigger?.reasonCode ?? 'other',
    reason: reasonParts.join('｜'),
    actionAdvice: trigger
      ? `候选人已收到"会有人跟进"的承诺，请按承诺内容接手并处理 ${trigger.toolName} 失败的事项。`
      : '候选人已收到"会有人跟进"的承诺。请按承诺内容接手该会话；若判定无需人工，直接恢复托管即可。',
    workOrderId: trigger?.workOrderId ?? params.resolvedWorkOrderId ?? null,
    jobId: trigger?.jobId ?? params.focusJobId ?? null,
    stage: params.stage ?? null,
    currentMessageContent: params.userMessage,
    idempotencyKey: buildHandoffIdempotencyKey({
      chatId: params.sessionRef.sessionId,
      turnId: params.turnId,
    }),
    recordHandoff: true,
  };
}

interface TriggeringToolFailure {
  toolName: string;
  errorType: string;
  reasonCode: string;
  workOrderId?: number | null;
  jobId?: number | null;
}

/** 本轮最后一个失败的业务工具 → 对应原因码；无失败工具返回 undefined。 */
export function resolveTriggeringToolFailure(
  toolCalls: AgentToolCall[],
): TriggeringToolFailure | undefined {
  for (let index = toolCalls.length - 1; index >= 0; index -= 1) {
    const call = toolCalls[index];
    const result = asRecord(call.result);
    const errorType = typeof result?.errorType === 'string' ? result.errorType : undefined;
    if (!errorType) continue;
    const args = asRecord(call.args);
    const workOrderId = readNumber(args?.workOrderId) ?? readNumber(result?.workOrderId);
    const jobId = readNumber(args?.jobId) ?? readNumber(result?.jobId);
    switch (call.toolName) {
      case 'duliday_modify_interview_time':
      case 'duliday_cancel_work_order':
        return {
          toolName: call.toolName,
          errorType,
          reasonCode: 'modify_appointment',
          workOrderId,
        };
      case 'duliday_interview_booking':
        return {
          toolName: call.toolName,
          errorType,
          reasonCode: classifyBookingFailure(result),
          jobId,
        };
      case 'invite_to_group':
        return { toolName: call.toolName, errorType, reasonCode: 'group_invite_failed', jobId };
      case 'send_store_location':
        return { toolName: call.toolName, errorType, reasonCode: 'cannot_find_store', jobId };
      default:
        continue;
    }
  }
  return undefined;
}

/** 报名失败的原因码：海绵拒绝语义能分出名额满/重复报名，其余算系统卡点。 */
export function classifyBookingFailure(result: Record<string, unknown> | undefined): string {
  const message = [result?.apiMessage, result?.reason, result?._outcome]
    .map((value) => (typeof value === 'string' ? value : ''))
    .join(' ');
  if (/已报名|重复报名/u.test(message)) return 'duplicate_signup';
  if (/上限|已满|名额/u.test(message)) return 'booking_capacity_full';
  return 'system_blocked';
}

function hasCompletedHandoffAction(call: AgentToolCall): boolean {
  const result = asRecord(call.result);
  if (call.toolName === 'request_handoff') {
    return result?.shortCircuited === true || result?.dispatched === true;
  }
  if (call.toolName === 'raise_risk_alert') {
    return Boolean(result && result.success !== false && typeof result.errorType !== 'string');
  }
  // 工具自带转人工副作用（取消/改约失败回执）：介入已由该副作用承担，不再对账补一次。
  return carriesGeneralHandoffSideEffect(result);
}

function carriesGeneralHandoffSideEffect(result: Record<string, unknown> | undefined): boolean {
  if (!result) return false;
  const candidates = [
    result.sideEffect,
    ...(Array.isArray(result.sideEffects) ? result.sideEffects : []),
  ];
  return candidates.some((item) => asRecord(item)?.kind === 'general_handoff');
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length > MAX_QUOTE_LENGTH
    ? `${normalized.slice(0, MAX_QUOTE_LENGTH)}…`
    : normalized;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
