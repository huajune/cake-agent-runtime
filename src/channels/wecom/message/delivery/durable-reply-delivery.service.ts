import { RUNTIME_RETRY_LIMITS } from '@infra/config/constants/runtime-retry.constants';
import { sleep } from '@infra/utils/async.util';
import {
  ReplySendError,
  classifyReplySendError,
  isRetryableReplyEvidence,
} from './reply-send-error';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import type { ActionIntent } from '@biz/action-execution/action-execution.types';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { ReplyDeferredError, type ReplyTurn } from '@biz/reply-execution/reply-execution.types';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { MessageSenderService } from '../../message-sender/message-sender.service';
import { SendMessageType } from '../../message-sender/dto/send-message.dto';
import type { DeliveryContext } from '../types';
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
    if (this.turns.mode === ACTION_MODE.EXECUTE)
      throw new ReplyDeferredError('delivery_identity_not_persisted');
    return undefined;
  }

  /** One live pass; only attempted segments enter the action ledger, never a whole text plan. */
  async sendOrdinarySegment(
    turn: ReplyTurn,
    context: DeliveryContext,
    text: string,
    index: number,
  ): Promise<void> {
    if (turn.mode !== ACTION_MODE.EXECUTE)
      throw new ReplyDeferredError('ordinary_reply_not_executable');
    for (let attempt = 0; attempt <= RUNTIME_RETRY_LIMITS.deliverySegmentRetries; attempt++) {
      const execution = await this.executor.execute(
        this.intent(turn, text, index),
        {
          authorize: async () => {
            await context.assertOwned?.();
            await this.turns.assertDeliveryActive(turn);
            return (
              await this.permit.evaluate({
                chatId: turn.chatId,
                action: context.action ?? PERMITTED_ACTION.REPLY,
                botImId: turn.accountId,
                groupId: context.groupId,
                candidateIds: [context.imContactId],
              })
            ).allowed;
          },
          dispatch: async (requestId) => {
            await context.assertOwned?.();
            await this.turns.assertDeliveryActive(turn);
            try {
              const response = await this.sender.sendMessage({
                token: context.token,
                imBotId: turn.accountId,
                imContactId: context.imContactId,
                imRoomId: context.imRoomId,
                chatId: turn.chatId,
                messageType: SendMessageType.TEXT,
                payload: { text },
                externalRequestId: requestId,
                _apiType: context._apiType,
              });
              if (response?.errcode !== 0)
                throw new ReplySendError(true, false, 'reply_send_result_unconfirmed');
              return {
                status: ACTION_STATE.SUCCEEDED,
                result: { stage: ACTION_EVIDENCE_KIND.ACCEPTED },
                evidence: {
                  kind: ACTION_EVIDENCE_KIND.ACCEPTED,
                  requestTerminated: true,
                  detail: 'send_api_accepted; not_delivery_or_read_receipt',
                },
              };
            } catch (error) {
              const failure = classifyReplySendError(error);
              return {
                status: failure.unknownResult ? ACTION_STATE.UNKNOWN : ACTION_STATE.FAILED,
                retryable: failure.retryable,
                evidence: {
                  kind: failure.unknownResult
                    ? ACTION_EVIDENCE_KIND.INDETERMINATE
                    : ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT,
                  requestTerminated: !failure.unknownResult,
                  detail: failure.message,
                },
              };
            }
          },
        },
        { persistedMode: turn.mode },
      );
      if (execution.status === ACTION_STATE.SUCCEEDED) return;
      const retryable =
        execution.status === ACTION_STATE.FAILED &&
        execution.evidence?.kind === ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT &&
        execution.evidence.requestTerminated &&
        isRetryableReplyEvidence(execution.evidence.detail);
      if (retryable && attempt < RUNTIME_RETRY_LIMITS.deliverySegmentRetries) {
        await sleep(800 * 2 ** attempt);
        continue;
      }
      throw new ReplySendError(
        execution.status === ACTION_STATE.UNKNOWN || execution.status === ACTION_STATE.EXECUTING,
        false,
        execution.reason ?? execution.evidence?.detail ?? execution.status,
      );
    }
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
            const failure = classifyReplySendError(error);
            return {
              status: failure.unknownResult ? ACTION_STATE.UNKNOWN : ACTION_STATE.FAILED,
              retryable: false,
              evidence: {
                kind: failure.unknownResult
                  ? ACTION_EVIDENCE_KIND.INDETERMINATE
                  : ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT,
                requestTerminated: !failure.unknownResult,
                detail: failure.message,
              },
            };
          }
          return {
            status: ACTION_STATE.SUCCEEDED,
            result: { stage: ACTION_EVIDENCE_KIND.ACCEPTED },
            evidence: {
              kind: ACTION_EVIDENCE_KIND.ACCEPTED,
              requestTerminated: true,
            },
          };
        },
      },
    );
    if (externalError) throw externalError;
    if (!result.dispatched) throw new ReplyDeferredError(result.reason ?? result.status);
  }

  private intent(turn: ReplyTurn, text: string, index: number): ActionIntent {
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
      identityReliable: true,
      recovery: { logicalTurnId: turn.logicalTurnId, index },
    };
  }
}
