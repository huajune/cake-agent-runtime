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
import {
  REPLY_SEGMENT_PRECHECK_PENDING,
  type ActionIntent,
} from '@biz/action-execution/action-execution.types';
import { ReplyTurnsService } from '@biz/reply-execution/reply-turns.service';
import { REPLY_DELIVERY_OUTCOME } from '@biz/reply-execution/reply-execution.constants';
import {
  ReplyDeferredError,
  ReplyDeliveryDeferredError,
  type ReplyTurn,
} from '@biz/reply-execution/reply-execution.types';
import { ActionPermitService } from '@biz/action-permit/services/action-permit.service';
import { MessageSenderService } from '../../message-sender/message-sender.service';
import { SendMessageType } from '../../message-sender/dto/send-message.dto';
import type { DeliveryContext, RecoveryDeliveryContext } from '../types';
import {
  ACTION_EVIDENCE_KIND,
  ACTION_EXECUTION_STATUS,
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

  /** Recovery walks the same immutable action identities. The executor returns accepted
   * segments without calling WeCom and holds the suffix behind any in-flight segment. */
  async resumeSegments(turn: ReplyTurn, context: RecoveryDeliveryContext): Promise<ReplyTurn> {
    const segments = turn.recovery.replySegments;
    if (!segments?.length) throw new ReplyDeferredError('missing_reply_segments');
    let accepted = 0;
    for (const segment of segments) {
      try {
        await this.sendOrdinarySegment(turn, context, segment, accepted);
      } catch (error) {
        if (!(error instanceof ReplySendError) || error.unknownResult)
          throw new ReplyDeliveryDeferredError(error, accepted);
        await context.assertOwned?.();
        return this.turns.settle(turn, {
          outcome:
            error.message === 'permission_or_freshness_changed' ||
            error.message === ACTION_STATE.CANCELLED
              ? REPLY_DELIVERY_OUTCOME.SKIPPED
              : REPLY_DELIVERY_OUTCOME.INCOMPLETE,
          accepted,
          total: segments.length,
        });
      }
      accepted++;
    }
    await context.assertOwned?.();
    return this.turns.settle(turn, {
      outcome: REPLY_DELIVERY_OUTCOME.COMPLETE,
      accepted,
      total: segments.length,
    });
  }

  async sendOrdinarySegment(
    turn: ReplyTurn,
    context: DeliveryContext | RecoveryDeliveryContext,
    text: string,
    index: number,
  ): Promise<void> {
    if (turn.mode !== ACTION_MODE.EXECUTE)
      throw new ReplyDeferredError('ordinary_reply_not_executable');
    for (let attempt = 0; attempt <= RUNTIME_RETRY_LIMITS.deliverySegmentRetries; attempt++) {
      try {
        await context.assertOwned?.();
      } catch (error) {
        if (turn.recovery.replySegments)
          throw new ReplyDeferredError(REPLY_SEGMENT_PRECHECK_PENDING, error);
        throw error;
      }
      let token = 'token' in context ? context.token : '';
      const execution = await this.executor.execute(
        this.intent(turn, text, index),
        {
          authorize: async () => {
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
            // A slow final SQL response must not start a new HTTP request past the cutoff.
            if (turn.fence > 1 && !(Date.parse(turn.recovery.resumeUntil ?? '') >= Date.now())) {
              return {
                status: ACTION_STATE.FAILED,
                retryable: false,
                evidence: {
                  kind: ACTION_EVIDENCE_KIND.DEFINITIVE_NO_EFFECT,
                  requestTerminated: true,
                  detail: REPLY_SEGMENT_PRECHECK_PENDING,
                },
              };
            }
            try {
              const response = await this.sender.sendMessage({
                token,
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
        {
          persistedMode: turn.mode,
          replySegment: {
            turn,
            beforeClaim: async () => {
              if ('resolveToken' in context) token = await context.resolveToken();
              await context.assertOwned?.();
            },
          },
        },
      );
      if (execution.status === ACTION_STATE.SUCCEEDED) return;
      if (
        turn.recovery.replySegments &&
        (execution.evidence?.detail === REPLY_SEGMENT_PRECHECK_PENDING ||
          (execution.status === ACTION_EXECUTION_STATUS.BLOCKED &&
            execution.reason !== 'permission_or_freshness_changed'))
      ) {
        throw new ReplyDeferredError(execution.reason ?? 'segment_ownership_unconfirmed');
      }
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
