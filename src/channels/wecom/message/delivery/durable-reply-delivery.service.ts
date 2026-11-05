import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import { identifyAction } from '@biz/action-execution/action-identity';
import type { ActionIntent } from '@biz/action-execution/action-execution.types';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { MessageSenderService } from '../../message-sender/message-sender.service';
import { SendMessageType } from '../../message-sender/dto/send-message.dto';
import type { DeliveryContext, DeliveryResult } from '../types';
import { REPLY_RECOVERY_TASK } from '@biz/reply-execution/reply-execution.constants';
import {
  ACTION_EVIDENCE_KIND,
  ACTION_KIND,
  ACTION_MODE,
  ACTION_STATE,
} from '@shared-types/action-execution.contract';
import { PERMITTED_ACTION } from '@shared-types/action-permit.types';

/** Ordinary replies complete on send API acceptance, without claiming delivery/read. */
@Injectable()
export class DurableReplyDeliveryService implements OnModuleInit {
  constructor(
    readonly turns: ReplyTurnsService,
    private readonly executor: ActionExecutorService,
    private readonly recovery: ActionRecoveryRegistry,
    private readonly permit: ActionPermitService,
    private readonly sender: MessageSenderService,
  ) {}
  onModuleInit(): void {
    this.recovery.register(ACTION_KIND.WECOM_REPLY_SEGMENT, {
      reconcile: async () => ({
        status: ACTION_STATE.UNKNOWN,
        evidence: {
          kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
          requestTerminated: false,
          detail:
            'No verified request lookup/idempotency contract; await exact callback or manual review',
        },
      }),
    });
  }

  async resolveTurn(context: DeliveryContext): Promise<ReplyTurn | undefined> {
    if (context.replyTurn) return context.replyTurn;
    if (!context.logicalTurnId || !context.inputOccurredAt || !context.corpId) {
      if (this.turns.mode === ACTION_MODE.EXECUTE)
        throw new ReplyDeferredError('delivery_identity_not_persisted');
      return undefined;
    }
    if (
      this.turns.mode === ACTION_MODE.EXECUTE &&
      context.taskRecovery?.kind === REPLY_RECOVERY_TASK.REENGAGEMENT
    ) {
      const data = context.taskRecovery.data as { jobData?: { dispatchDueAt?: number } };
      const due = data.jobData?.dispatchDueAt;
      if (
        typeof due !== 'number' ||
        !Number.isFinite(due) ||
        due < Date.parse(context.inputOccurredAt) ||
        due > Date.now() + 60_000 ||
        due <= Date.now() - 24 * 3600_000
      )
        throw new ReplyDeferredError('task_dispatch_window_unconfirmed_or_expired');
    }
    return this.turns.open(
      { corpId: context.corpId, accountId: context.imBotId, chatId: context.chatId },
      [`task:${context.logicalTurnId}`],
      context.inputOccurredAt,
      {
        action: context.action ?? PERMITTED_ACTION.REPLY,
        ...(context.taskRecovery ? { task: context.taskRecovery } : {}),
      },
    );
  }

  async prepare(
    turn: ReplyTurn,
    text: string,
    segments: string[],
    resume?: Record<string, unknown>,
  ): Promise<ReplyTurn> {
    if (turn.plan) return turn;
    return this.turns.savePlan(turn, {
      version: 1,
      text,
      resume,
      segments: segments.map((segment, index) => ({
        index,
        text: segment,
        ...identifyAction(this.intent(turn, segment, index)),
      })),
    });
  }

  async deliver(turn: ReplyTurn, context: DeliveryContext): Promise<DeliveryResult> {
    if (turn.mode !== ACTION_MODE.EXECUTE)
      throw new ReplyDeferredError('reply_plan_not_executable');
    if (!turn.plan) throw new ReplyDeferredError('missing_reply_plan');
    let completed = 0;
    let cancelled = false;
    for (const segment of turn.plan.segments) {
      const execution = await this.executor.execute(
        this.intent(turn, segment.text, segment.index),
        {
          authorize: async () => {
            await context.assertOwned?.();
            return (
              !cancelled &&
              (
                await this.permit.evaluate({
                  chatId: turn.chatId,
                  action: context.action ?? PERMITTED_ACTION.REPLY,
                  botImId: turn.accountId,
                  groupId: context.groupId,
                  candidateIds: [context.imContactId],
                })
              ).allowed
            );
          },
          dispatch: async (requestId, mode) => {
            await context.assertOwned?.();
            const response = await this.sender.sendMessage({
              token: context.token,
              imBotId: turn.accountId,
              imContactId: context.imContactId,
              imRoomId: context.imRoomId,
              chatId: turn.chatId,
              messageType: SendMessageType.TEXT,
              payload: { text: segment.text },
              externalRequestId:
                mode === ACTION_MODE.EXECUTE ? requestId : context.externalRequestId,
              _apiType: context._apiType,
            });
            if (turn.recovery.primary) {
              if (response?.errcode !== 0) throw new Error('reply_send_result_unconfirmed');
              return {
                status: ACTION_STATE.SUCCEEDED,
                result: { stage: ACTION_EVIDENCE_KIND.ACCEPTED },
                evidence: {
                  kind: ACTION_EVIDENCE_KIND.ACCEPTED,
                  requestTerminated: true,
                  detail: 'send_api_accepted; not_delivery_or_read_receipt',
                },
              };
            }
            return {
              status: ACTION_STATE.EXECUTING,
              result: { stage: ACTION_EVIDENCE_KIND.ACCEPTED },
              evidence: {
                kind: ACTION_EVIDENCE_KIND.ACCEPTED,
                requestTerminated: false,
                detail: 'Await provider delivery callback; not delivered/read',
              },
            };
          },
        },
        { persistedMode: turn.mode },
      );
      if (execution.status === ACTION_STATE.SUCCEEDED) {
        completed++;
        continue;
      }
      if (
        execution.status === ACTION_STATE.CANCELLED ||
        execution.reason === 'permission_or_freshness_changed' ||
        (execution.status === ACTION_STATE.FAILED &&
          execution.evidence?.kind === ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT &&
          execution.evidence.requestTerminated &&
          execution.evidence.detail === 'permission_changed_before_dispatch')
      ) {
        cancelled = true;
        continue;
      }
      // No next segment and no retry even after a timeout: the request may have arrived.
      throw new ReplyDeferredError(`segment_${segment.index}_${execution.status}`);
    }
    return {
      success: true,
      segmentCount: turn.plan.segments.length,
      deliveredSegments: completed,
      failedSegments: 0,
      totalTime: 0,
      skipped: cancelled || undefined,
    };
  }

  async observeLegacy(
    context: DeliveryContext,
    text: string,
    index: number,
    dispatch: () => Promise<void>,
  ): Promise<void> {
    let externalError: unknown;
    const result = await this.executor.execute(
      {
        corpId: context.corpId ?? 'default',
        accountId: context.imBotId,
        chatId: context.chatId,
        logicalTurnId: context.logicalTurnId ?? context.messageId,
        intentId: `${context.logicalTurnId ?? context.messageId}:observed-reply:${index}`,
        kind: ACTION_KIND.WECOM_REPLY_SEGMENT,
        target: `chat:${context.chatId}:observed-reply:${context.messageId}:${index}`,
        parameters: { text, index },
        occurredAt: context.inputOccurredAt ?? new Date().toISOString(),
        identityReliable: false,
      },
      {
        dispatch: async (_requestId, mode) => {
          if (mode === ACTION_MODE.EXECUTE)
            throw new ReplyDeferredError('legacy_delivery_identity');
          try {
            await dispatch();
          } catch (error) {
            externalError = error;
            throw error;
          }
          return {
            status: ACTION_STATE.EXECUTING,
            result: { stage: ACTION_EVIDENCE_KIND.ACCEPTED },
            evidence: { kind: ACTION_EVIDENCE_KIND.ACCEPTED, requestTerminated: false },
          };
        },
      },
    );
    if (externalError) throw externalError;
    if (!result.dispatched) throw new ReplyDeferredError(result.reason ?? result.status);
  }

  private intent(turn: ReplyTurn, text: string, index: number): ActionIntent {
    const task = turn.recovery.task as
      | {
          kind?: string;
          data?: { jobData?: { dispatchDueAt?: number } };
        }
      | undefined;
    const due =
      task?.kind === REPLY_RECOVERY_TASK.REENGAGEMENT
        ? task.data?.jobData?.dispatchDueAt
        : undefined;
    return {
      corpId: turn.corpId,
      accountId: turn.accountId,
      chatId: turn.chatId,
      logicalTurnId: turn.logicalTurnId,
      intentId: `${turn.logicalTurnId}:reply:v1:${index}`,
      kind: ACTION_KIND.WECOM_REPLY_SEGMENT,
      target: `chat:${turn.chatId}:reply:${turn.logicalTurnId}:segment:${index}`,
      parameters: { text, index, version: 1 },
      occurredAt: turn.inputOccurredAt,
      ...(typeof due === 'number' && Number.isFinite(due)
        ? { recoveryWindowStartedAt: new Date(due).toISOString() }
        : {}),
      identityReliable: true,
      recovery: { logicalTurnId: turn.logicalTurnId, index },
    };
  }
}
