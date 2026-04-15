import { Injectable } from '@nestjs/common';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { ConversationRiskNotifierService } from '@notification/services/conversation-risk-notifier.service';
import type {
  ConversationRiskHandleResult,
  ConversationRiskContext,
  ConversationRiskDetectionResult,
} from '../types/conversation-risk.types';
import { CONVERSATION_RISK_ALERT_WINDOW_MS } from '../rules/conversation-risk.rules';

@Injectable()
export class ConversationRiskActionService {
  private readonly alertWindows = new Map<string, number>();

  constructor(
    private readonly userHostingService: UserHostingService,
    private readonly notifierService: ConversationRiskNotifierService,
  ) {}

  async handleHit(
    context: ConversationRiskContext,
    detection: ConversationRiskDetectionResult,
  ): Promise<ConversationRiskHandleResult> {
    if (!context.pauseTargetId) {
      return {
        hit: true,
        paused: false,
        alerted: false,
        reason: detection.reason,
      };
    }

    const alreadyPaused = await this.userHostingService.isUserPaused(context.pauseTargetId);
    if (alreadyPaused) {
      return {
        hit: true,
        paused: false,
        alerted: false,
        reason: 'already-paused',
      };
    }

    await this.userHostingService.pauseUser(context.pauseTargetId);

    const dedupeKey = context.pauseTargetId;
    const reserved = this.reserveAlertSlot(dedupeKey);
    if (!reserved) {
      return {
        hit: true,
        paused: true,
        alerted: false,
        deduped: true,
        reason: detection.reason,
      };
    }

    const alerted = await this.notifierService.notifyConversationRisk({
      botImId: context.botImId,
      riskLabel: detection.riskLabel || '交流异常',
      summary: detection.summary || '候选人对话出现异常风险',
      reason: detection.reason || '命中交流异常规则',
      contactName: context.contactName,
      chatId: context.chatId,
      pausedUserId: context.pauseTargetId,
      currentMessageContent: context.currentMessageContent,
      recentMessages: context.recentMessages,
      sessionState: context.sessionState,
    });

    if (!alerted) {
      this.alertWindows.delete(dedupeKey);
    }

    return {
      hit: true,
      paused: true,
      alerted,
      reason: detection.reason,
    };
  }

  private reserveAlertSlot(key: string): boolean {
    const now = Date.now();
    const lastSentAt = this.alertWindows.get(key);

    if (lastSentAt && now - lastSentAt < CONVERSATION_RISK_ALERT_WINDOW_MS) {
      return false;
    }

    this.alertWindows.set(key, now);
    return true;
  }
}
