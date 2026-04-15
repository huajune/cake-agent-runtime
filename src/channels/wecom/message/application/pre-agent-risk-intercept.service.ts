import { Injectable, Logger } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { InterventionService } from '@notification/intervention/intervention.service';
import { ConversationRiskDetectorService } from '@/conversation-risk/services/conversation-risk-detector.service';
import type { ConversationRiskContext } from '@/conversation-risk/types/conversation-risk.types';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';

export interface PreAgentRiskPrecheckResult {
  hit: boolean;
  riskType?: string;
  reason?: string;
  label?: string;
}

/**
 * Pre-Agent 同步风险预检
 *
 * 职责：在 Agent 推理之前，用高置信度关键词规则判断候选人最近消息是否存在
 * 明显辱骂/投诉/举报等信号。命中即同步触发人工介入副作用：
 *   - 暂停托管（下一轮候选人发言将不再触发 Agent 回复）
 *   - 飞书告警（通知人工接手）
 *
 * 本服务不短路 Agent，也不生成任何预设话术：本轮的安抚回复仍由 Agent
 * 以招募者身份自主组织，避免暴露机器人/托管身份。Agent 自身也可以在
 * 推理过程中通过 `raise_risk_alert` 工具主动触发同样的副作用。
 */
@Injectable()
export class PreAgentRiskInterceptService {
  private readonly logger = new Logger(PreAgentRiskInterceptService.name);

  constructor(
    private readonly detector: ConversationRiskDetectorService,
    private readonly interventionService: InterventionService,
    private readonly chatSessionService: ChatSessionService,
    private readonly sessionService: SessionService,
  ) {}

  async precheck(params: {
    messageData: EnterpriseMessageCallbackDto;
    content: string;
  }): Promise<PreAgentRiskPrecheckResult> {
    const parsed = MessageParser.parse(params.messageData);
    const chatId = parsed.chatId;
    const userId = parsed.imContactId || params.messageData.externalUserId || chatId;
    const corpId = parsed.orgId || 'default';
    const content = params.content?.trim() ?? '';

    if (!chatId || !userId || !content) {
      return { hit: false };
    }

    const [recentMessages, sessionState] = await Promise.all([
      this.chatSessionService.getChatHistory(chatId, 10).catch(() => []),
      this.sessionService.getSessionState(corpId, userId, chatId).catch(() => null),
    ]);

    const context: ConversationRiskContext = {
      corpId,
      chatId,
      userId,
      pauseTargetId: chatId || userId,
      messageId: parsed.messageId,
      contactName: parsed.contactName,
      botImId: parsed.imBotId,
      botUserName: parsed.managerName,
      currentMessageContent: content,
      recentMessages: recentMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
        timestamp: m.timestamp,
      })),
      sessionState,
    };

    const detection = this.detector.detect(context);
    if (!detection.hit) {
      return { hit: false };
    }

    this.logger.warn(
      `[PreAgentRiskPrecheck] 命中规则: chatId=${chatId}, type=${detection.riskType}, reason=${detection.reason}`,
    );

    await this.interventionService.dispatch({
      kind: 'conversation_risk',
      source: 'regex_intercept',
      riskType: detection.riskType ?? 'abuse',
      riskLabel: detection.riskLabel ?? '交流异常',
      summary: detection.summary ?? '候选人消息命中高置信度风险关键词',
      reason: detection.reason ?? '命中规则',
      chatId,
      corpId,
      userId,
      pauseTargetId: context.pauseTargetId,
      botImId: parsed.imBotId,
      botUserName: parsed.managerName,
      contactName: parsed.contactName,
      currentMessageContent: content,
      recentMessages: context.recentMessages,
      sessionState,
    });

    return {
      hit: true,
      riskType: detection.riskType,
      reason: detection.reason,
      label: detection.riskLabel,
    };
  }
}
