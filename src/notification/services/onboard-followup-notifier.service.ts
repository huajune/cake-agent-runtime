import { Injectable, Logger } from '@nestjs/common';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import { OnboardFollowupCardRenderer } from '../renderers/onboard-followup-card.renderer';
import { OnboardFollowupNotificationPayload } from '../types/onboard-followup-notification.types';

@Injectable()
export class OnboardFollowupNotifierService {
  private readonly logger = new Logger(OnboardFollowupNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly cardRenderer: OnboardFollowupCardRenderer,
    private readonly hostingMemberConfig: HostingMemberConfigService,
  ) {}

  async notify(payload: OnboardFollowupNotificationPayload): Promise<boolean> {
    const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(payload.botImId);
    const card = this.cardRenderer.buildCard({
      ...payload,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.privateChatChannel.send(card);
    if (success) {
      this.logger.warn(
        `面试及上岗对接通知已发送: chatId=${payload.chatId}, alert=${payload.alertLabel}`,
      );
    } else {
      this.logger.warn(
        `面试及上岗对接通知发送失败: chatId=${payload.chatId}, alert=${payload.alertLabel}`,
      );
    }
    return success;
  }
}
