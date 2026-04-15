import { Injectable } from '@nestjs/common';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { SessionService } from '@memory/services/session.service';
import { ConversationRiskContext } from '../types/conversation-risk.types';

@Injectable()
export class ConversationRiskContextService {
  constructor(
    private readonly chatSessionService: ChatSessionService,
    private readonly sessionService: SessionService,
  ) {}

  async buildContext(params: {
    corpId: string;
    chatId: string;
    userId: string;
    pauseTargetId: string;
    messageId: string;
    contactName?: string;
    botImId?: string;
    currentMessageContent: string;
  }): Promise<ConversationRiskContext> {
    const [recentMessages, sessionState] = await Promise.all([
      this.chatSessionService.getChatHistory(params.chatId, 10),
      this.sessionService.getSessionState(params.corpId, params.userId, params.chatId),
    ]);

    return {
      ...params,
      recentMessages: recentMessages.map((message) => ({
        role: message.role,
        content: message.content,
        timestamp: message.timestamp,
      })),
      sessionState,
    };
  }
}
