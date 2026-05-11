import { Injectable, Logger } from '@nestjs/common';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import { GeneralHandoffCardRenderer } from '../renderers/general-handoff-card.renderer';
import { GeneralHandoffNotificationPayload } from '../types/general-handoff-notification.types';

@Injectable()
export class GeneralHandoffNotifierService {
  private readonly logger = new Logger(GeneralHandoffNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly cardRenderer: GeneralHandoffCardRenderer,
  ) {}

  async notify(payload: GeneralHandoffNotificationPayload): Promise<boolean> {
    if (payload.chatId.startsWith('test-')) {
      this.logger.log(
        `[skip] 测试会话不推送飞书告警: chatId=${payload.chatId}, label=${payload.alertLabel}`,
      );
      return true;
    }

    const receiver = payload.botImId ? BOT_TO_RECEIVER[payload.botImId] : undefined;
    const card = this.cardRenderer.buildCard({
      ...payload,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.privateChatChannel.send(card);
    if (success) {
      this.logger.warn(
        `通用人工介入告警已发送: chatId=${payload.chatId}, label=${payload.alertLabel}`,
      );
    } else {
      this.logger.warn(
        `通用人工介入告警发送失败: chatId=${payload.chatId}, label=${payload.alertLabel}`,
      );
    }
    return success;
  }
}
