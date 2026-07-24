import { Injectable, Logger } from '@nestjs/common';
import { InterventionService } from '@biz/intervention/intervention.service';
import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';
import type { HandoffWriteOutcome } from '@biz/handoff-events/handoff-events.types';
import { buildHandoffIdempotencyKey } from './handoff-idempotency';
import type { TurnOutcome } from './agent-runner.types';
import type {
  GeneralHandoffSideEffectIntent,
  TurnSideEffectIntent,
} from './turn-side-effect.types';

export interface TurnOutcomeCommitContext {
  traceId: string;
  chatId: string;
  userId: string;
  corpId: string;
  contactName?: string;
  botImId?: string;
  botUserId?: string;
  userMessage: string;
}

/**
 * Outcome 层最终提交出口。
 *
 * Guardrail / outcome 只负责判定并在 TurnOutcome.sideEffects 上声明意图；渠道侧在 replay
 * 已确定最终回合后调用本服务 commit 最终 outcome。这样不会因为被 replay 丢弃的首版回复
 * 误触发暂停托管/告警。
 */
@Injectable()
export class TurnOutcomeInterventionService {
  private readonly logger = new Logger(TurnOutcomeInterventionService.name);

  constructor(
    private readonly interventionService: InterventionService,
    private readonly handoffRecorder: HandoffRecorderService,
  ) {}

  async commit(outcome: TurnOutcome | undefined, context: TurnOutcomeCommitContext): Promise<void> {
    if (!outcome) return;
    for (const intent of this.resolveSideEffects(outcome, context)) {
      await this.dispatchIntent(intent, context);
    }
  }

  /** @deprecated 迁移兼容；新调用方请使用 commit。 */
  async dispatchIfNeeded(
    outcome: TurnOutcome | undefined,
    context: TurnOutcomeCommitContext,
  ): Promise<void> {
    await this.commit(outcome, context);
  }

  private async dispatchIntent(
    intent: TurnSideEffectIntent,
    context: TurnOutcomeCommitContext,
  ): Promise<void> {
    if (intent.alreadyDispatched) {
      this.logger.warn(
        `[OutcomeSideEffect] already dispatched, skip duplicate: kind=${intent.kind}, chatId=${context.chatId}`,
      );
      return;
    }
    if (intent.kind === 'conversation_risk') {
      await this.dispatchConversationRisk(intent, context);
      return;
    }
    await this.dispatchGeneralHandoff(intent, context);
  }

  private resolveSideEffects(
    outcome: TurnOutcome,
    context: TurnOutcomeCommitContext,
  ): TurnSideEffectIntent[] {
    // 守卫显式声明的意图优先（如入站拦截的 conversation_risk 暂停/告警）。
    const declared = outcome.sideEffects ?? [];

    if (outcome.kind !== 'handoff' || !outcome.handoff) return declared;
    // classifyReviewedOutcome 已把 handoff 意图放进 sideEffects 时不再追加，
    // 否则同一转人工会被 record+dispatch 两次（幂等键相同也会多打一次告警）。
    const handoffAlreadyDeclared = declared.some(
      (intent) =>
        intent.kind === 'general_handoff' &&
        intent.idempotencyKey === outcome.handoff?.idempotencyKey,
    );
    if (handoffAlreadyDeclared) return declared;
    return [
      ...declared,
      {
        kind: 'general_handoff',
        source: 'agent_tool',
        alertLabel: 'Agent 转人工',
        reasonCode: outcome.handoff.reasonCode,
        reason: outcome.handoff.reason ?? outcome.handoff.reasonCode,
        idempotencyKey: outcome.handoff.idempotencyKey,
        alreadyDispatched: outcome.handoff.alreadyDispatched,
        currentMessageContent: context.userMessage,
      },
    ];
  }

  private async dispatchConversationRisk(
    intent: Extract<TurnSideEffectIntent, { kind: 'conversation_risk' }>,
    context: TurnOutcomeCommitContext,
  ): Promise<void> {
    const occurredAt = Date.now();
    try {
      const result = await this.interventionService.dispatch({
        kind: 'conversation_risk',
        source: intent.source,
        riskType: intent.riskType,
        riskLabel: intent.riskLabel,
        summary: intent.summary,
        reason: intent.reason,
        chatId: context.chatId,
        corpId: context.corpId,
        userId: context.userId,
        pauseTargetId: context.chatId,
        botImId: context.botImId,
        botUserName: context.botUserId,
        contactName: context.contactName,
        currentMessageContent: intent.currentMessageContent ?? context.userMessage,
        recentMessages: intent.recentMessages ?? [
          { role: 'user', content: context.userMessage, timestamp: occurredAt },
        ],
        sessionState: intent.sessionState ?? null,
      });
      this.logger.warn(
        `[OutcomeSideEffect] conversation_risk dispatched: chatId=${context.chatId}, type=${intent.riskType}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
      );
    } catch (error) {
      this.logger.error(
        `[OutcomeSideEffect] conversation_risk dispatch 失败: chatId=${context.chatId}, error=${this.errorMessage(error)}`,
      );
    }
  }

  private async dispatchGeneralHandoff(
    intent: GeneralHandoffSideEffectIntent,
    context: TurnOutcomeCommitContext,
  ): Promise<void> {
    const occurredAt = new Date();
    const idempotencyKey =
      intent.idempotencyKey ||
      buildHandoffIdempotencyKey({ chatId: context.chatId, turnId: context.traceId });
    const shouldRecord = intent.recordHandoff !== false;

    if (shouldRecord) {
      const writeOutcome = await this.recordHandoff(intent, context, idempotencyKey, occurredAt);
      if (writeOutcome === 'duplicate') {
        this.logger.warn(
          `[OutcomeSideEffect] duplicate handoff，跳过重复 dispatch: chatId=${context.chatId}, key=${idempotencyKey}`,
        );
        return;
      }
      if (writeOutcome === 'failed') {
        this.logger.error(
          `[OutcomeSideEffect] handoff 底账写入失败，执行 fail-safe dispatch: chatId=${context.chatId}, key=${idempotencyKey}`,
        );
      }
    }

    try {
      const result = await this.interventionService.dispatch({
        kind: 'general_handoff',
        source: intent.source,
        alertLabel: intent.alertLabel,
        reasonCode: intent.reasonCode,
        reason: intent.reason,
        actionAdvice: intent.actionAdvice,
        missingJobInfo: intent.missingJobInfo,
        workOrderId: intent.workOrderId ?? null,
        chatId: context.chatId,
        corpId: context.corpId,
        userId: context.userId,
        pauseTargetId: context.chatId,
        botImId: intent.botImId ?? context.botImId,
        botUserName: context.botUserId,
        contactName: context.contactName,
        currentMessageContent: intent.currentMessageContent ?? context.userMessage,
        recentMessages: intent.recentMessages ?? [
          {
            role: 'user',
            content: context.userMessage,
            timestamp: occurredAt.getTime(),
          },
        ],
        sessionState: intent.sessionState ?? null,
      });
      this.logger.warn(
        `[OutcomeSideEffect] general_handoff dispatched: chatId=${context.chatId}, reasonCode=${intent.reasonCode}, paused=${result.paused}, alerted=${result.alerted}, suppressed=${result.suppressed ?? '-'}`,
      );
    } catch (error) {
      this.logger.error(
        `[OutcomeSideEffect] general_handoff dispatch 失败: chatId=${context.chatId}, error=${this.errorMessage(error)}`,
      );
    }
  }

  private async recordHandoff(
    intent: GeneralHandoffSideEffectIntent,
    context: TurnOutcomeCommitContext,
    idempotencyKey: string,
    occurredAt: Date,
  ): Promise<HandoffWriteOutcome> {
    try {
      return await this.handoffRecorder.record({
        corpId: context.corpId,
        chatId: context.chatId,
        userId: context.userId,
        reasonCode: intent.reasonCode,
        reason: intent.reason || null,
        actionAdvice: intent.actionAdvice ?? null,
        missingJobInfo: intent.missingJobInfo ?? null,
        stage: intent.stage ?? null,
        botImId: intent.botImId ?? context.botImId,
        workOrderId: intent.workOrderId ?? null,
        idempotencyKey,
        occurredAt,
      });
    } catch (error) {
      this.logger.error(
        `[OutcomeSideEffect] handoff 底账写入异常，继续 fail-safe dispatch: chatId=${context.chatId}, key=${idempotencyKey}, error=${this.errorMessage(error)}`,
      );
      return 'failed';
    }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
