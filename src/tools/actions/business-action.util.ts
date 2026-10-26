import { classifyBookingRejection } from '@sponge/booking-rejection';
import type {
  ActionCompletion,
  ActionExecution,
  ActionIntent,
} from '@biz/action-execution/action-execution.types';
import type { ToolBuildContext } from '@shared-types/tool.types';
import type { InterviewBookingResult, WorkOrderMutationResult } from '@sponge/sponge.types';

export function toolActionIntent(
  context: ToolBuildContext,
  input: Pick<ActionIntent, 'kind' | 'target' | 'parameters' | 'recovery'>,
): ActionIntent {
  const logicalTurnId = context.session.logicalTurnId ?? context.session.turnId ?? '';
  return {
    ...input,
    corpId: context.session.corpId,
    accountId: context.session.botImId ?? '',
    chatId: context.session.chatId ?? context.session.sessionId,
    logicalTurnId,
    intentId: logicalTurnId,
    occurredAt: context.session.inputOccurredAt ?? new Date().toISOString(),
    identityReliable: Boolean(context.session.logicalTurnId && context.session.inputOccurredAt),
  };
}

export function spongeActionCompletion<T extends InterviewBookingResult | WorkOrderMutationResult>(
  result: T,
  kind?: string,
): ActionCompletion<T> {
  if (result.success && result.code === 0)
    return {
      status: 'succeeded',
      result,
      evidence: {
        kind: 'completed',
        requestTerminated: true,
        ...('workOrderId' in result && result.workOrderId
          ? { externalId: String(result.workOrderId) }
          : {}),
      },
    };
  const rejection = kind === 'sponge.booking' ? classifyBookingRejection(result) : null;
  if (rejection)
    return {
      status: 'failed',
      result,
      retryable: false,
      evidence: {
        kind: 'definitive_no_effect',
        requestTerminated: true,
        detail: rejection,
      },
    };
  if ('duplicateSignupReason' in result && result.duplicateSignupReason)
    return {
      status: 'failed',
      result,
      retryable: false,
      evidence: {
        kind: 'definitive_no_effect',
        requestTerminated: true,
        // A brand-level duplicate does not prove this exact job is already booked.
        detail: result.duplicateSignupReason,
      },
    };
  if ('applyErrorList' in result && result.applyErrorList?.length)
    return {
      status: 'failed',
      result,
      retryable: false,
      evidence: {
        kind: 'definitive_no_effect',
        requestTerminated: true,
        detail: 'collection_fields_rejected',
      },
    };
  return {
    status: 'unknown',
    result,
    evidence: { kind: 'indeterminate', requestTerminated: false },
  };
}

/** Stable machine fields consumed by replay/continuation control; never infer these from prose. */
export function actionReceiptFields(action: ActionExecution<unknown>) {
  return {
    actionStatus: action.status,
    actionId: action.actionId,
    requestId: action.requestId,
    localSync: action.localSync,
    actionDispatched: action.dispatched,
    actionReason: action.reason,
  };
}

export function unresolvedActionReceipt(
  context: ToolBuildContext,
  action: ActionExecution<unknown>,
  label: string,
  jobId?: number,
  workOrderId?: number,
): Record<string, unknown> {
  const notDispatched = action.status === 'blocked' && !action.dispatched;
  return {
    ...actionReceiptFields(action),
    errorType: 'action.result_unresolved',
    _outcome: notDispatched
      ? `本次${label}尚未执行，需要人工核实`
      : `${label}结果暂未确认，已停止自动重试，需要人工核实`,
    _replyInstruction:
      (notDispatched
        ? `如实告诉候选人这次${label}尚未执行，会请同事核实。`
        : `如实告诉候选人这次${label}的结果还需要核实，会请同事跟进。`) +
      '人工意图尚不代表通知或暂停已经完成，不要声称已同步同事或已暂停托管。' +
      '禁止声称已经成功或失败，禁止重试或换参数重做；本轮已携带人工意图，不要再调用 request_handoff。',
    sideEffect: {
      kind: 'general_handoff',
      source: 'agent_tool',
      origin: 'agent_tool',
      reasonCode: workOrderId ? 'modify_appointment' : 'system_blocked',
      alertLabel: `${label}结果待核实`,
      reason: `${label}动作 ${action.actionId} 状态 ${action.status}，禁止未经核实重发。`,
      actionAdvice: '先核实原请求是否完成；结果不明时不要重新执行。',
      workOrderId: workOrderId ?? null,
      jobId: jobId ?? null,
      botImId: context.session.botImId,
      stage: context.archive.currentStage ?? null,
      recordHandoff: true,
    },
  };
}

export function isUnresolvedAction(result: ActionExecution<unknown>): boolean {
  return !['succeeded', 'failed'].includes(result.status);
}
