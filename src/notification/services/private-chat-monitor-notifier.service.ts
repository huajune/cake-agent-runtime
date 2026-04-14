import { Injectable, Logger } from '@nestjs/common';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import {
  BookingCardRenderer,
  InterviewBookingNotificationPayload,
} from '../renderers/booking-card.renderer';

export interface InterviewBookingNotificationInfo
  extends Omit<InterviewBookingNotificationPayload, 'atUsers' | 'atAll'> {
  botImId?: string;
}

@Injectable()
export class PrivateChatMonitorNotifierService {
  private readonly logger = new Logger(PrivateChatMonitorNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly bookingCardRenderer: BookingCardRenderer,
  ) {}

  async notifyInterviewBookingResult(
    bookingInfo: InterviewBookingNotificationInfo,
  ): Promise<boolean> {
    const receiver = bookingInfo.botImId ? BOT_TO_RECEIVER[bookingInfo.botImId] : undefined;
    const { isFailure, card } = this.bookingCardRenderer.buildInterviewBookingCard({
      ...bookingInfo,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.privateChatChannel.send(card);
    if (success) {
      this.logger.log(
        `面试预约${isFailure ? '失败' : '成功'}通知已发送: ${bookingInfo.candidateName}`,
      );
    } else {
      this.logger.warn(
        `面试预约${isFailure ? '失败' : '成功'}通知发送失败: ${bookingInfo.candidateName}`,
      );
    }
    return success;
  }
}
