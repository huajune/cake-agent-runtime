import { Injectable, Logger } from '@nestjs/common';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import { ConversationRiskCardRenderer } from '../renderers/conversation-risk-card.renderer';
import { ConversationRiskNotificationPayload } from '../types/conversation-risk-notification.types';

@Injectable()
export class ConversationRiskNotifierService {
  private readonly logger = new Logger(ConversationRiskNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly cardRenderer: ConversationRiskCardRenderer,
  ) {}

  async notifyConversationRisk(payload: ConversationRiskNotificationPayload): Promise<boolean> {
    const receiver = payload.botImId ? BOT_TO_RECEIVER[payload.botImId] : undefined;
    const card = this.cardRenderer.buildConversationRiskCard({
      ...payload,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.privateChatChannel.send(card);
    if (success) {
      this.logger.warn(`交流异常通知已发送: chatId=${payload.chatId}, risk=${payload.riskLabel}`);
    } else {
      this.logger.warn(`交流异常通知发送失败: chatId=${payload.chatId}, risk=${payload.riskLabel}`);
    }
    return success;
  }
}
