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

/** A send response means platform acceptance. Only a matching callback is completion. */
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
    this.recovery.register('wecom.reply_segment', {
      reconcile: async () => ({
        status: 'unknown',
        evidence: {
          kind: 'indeterminate',
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
      if (this.turns.mode === 'execute')
        throw new ReplyDeferredError('delivery_identity_not_persisted');
      return undefined;
    }
    return this.turns.open(
      { corpId: context.corpId, accountId: context.imBotId, chatId: context.chatId },
      [`task:${context.logicalTurnId}`],
      context.inputOccurredAt,
      { action: context.action ?? 'reply' },
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
    if (!turn.plan) throw new ReplyDeferredError('missing_reply_plan');
    let completed = 0;
    let cancelled = false;
    for (const segment of turn.plan.segments) {
      const execution = await this.executor.execute(
        this.intent(turn, segment.text, segment.index),
        {
          authorize: async () =>
            !cancelled &&
            (
              await this.permit.evaluate({
                chatId: turn.chatId,
                action: context.action ?? 'reply',
                botImId: turn.accountId,
                groupId: context.groupId,
                candidateIds: [context.imContactId],
              })
            ).allowed,
          dispatch: async (requestId, mode) => {
            await this.sender.sendMessage({
              token: context.token,
              imBotId: turn.accountId,
              imContactId: context.imContactId,
              imRoomId: context.imRoomId,
              chatId: turn.chatId,
              messageType: SendMessageType.TEXT,
              payload: { text: segment.text },
              externalRequestId: mode === 'execute' ? requestId : context.externalRequestId,
              _apiType: context._apiType,
            });
            return {
              status: 'executing',
              result: { stage: 'accepted' },
              evidence: {
                kind: 'accepted',
                requestTerminated: false,
                detail: 'Await provider delivery callback; not delivered/read',
              },
            };
          },
        },
      );
      if (execution.status === 'succeeded') {
        completed++;
        continue;
      }
      if (
        execution.status === 'cancelled' ||
        execution.reason === 'permission_or_freshness_changed' ||
        (execution.status === 'failed' &&
          execution.evidence?.kind === 'definitive_no_effect' &&
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
        kind: 'wecom.reply_segment',
        target: `chat:${context.chatId}:observed-reply:${context.messageId}:${index}`,
        parameters: { text, index },
        occurredAt: context.inputOccurredAt ?? new Date().toISOString(),
        identityReliable: false,
      },
      {
        dispatch: async (_requestId, mode) => {
          if (mode === 'execute') throw new ReplyDeferredError('legacy_delivery_identity');
          try {
            await dispatch();
          } catch (error) {
            externalError = error;
            throw error;
          }
          return {
            status: 'executing',
            result: { stage: 'accepted' },
            evidence: { kind: 'accepted', requestTerminated: false },
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
      kind: 'wecom.reply_segment',
      target: `chat:${turn.chatId}:reply:${turn.logicalTurnId}:segment:${index}`,
      parameters: { text, index, version: 1 },
      occurredAt: turn.inputOccurredAt,
      identityReliable: true,
      recovery: { logicalTurnId: turn.logicalTurnId, index },
    };
  }
}
