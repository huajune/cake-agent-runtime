import { Injectable, Logger } from '@nestjs/common';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import {
  BookingCardRenderer,
  InterviewCancellationNotificationPayload,
  InterviewBookingNotificationPayload,
} from '../renderers/booking-card.renderer';

export interface InterviewBookingNotificationInfo
  extends Omit<InterviewBookingNotificationPayload, 'atUsers' | 'atAll'> {
  botImId?: string;
}

export interface InterviewCancellationNotificationInfo
  extends Omit<InterviewCancellationNotificationPayload, 'atUsers' | 'atAll'> {
  botImId?: string;
}

@Injectable()
export class PrivateChatMonitorNotifierService {
  private readonly logger = new Logger(PrivateChatMonitorNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly bookingCardRenderer: BookingCardRenderer,
    private readonly hostingMemberConfig: HostingMemberConfigService,
  ) {}

  async notifyInterviewBookingResult(
    bookingInfo: InterviewBookingNotificationInfo,
  ): Promise<boolean> {
    const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(bookingInfo.botImId);
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

  async notifyInterviewCancellation(
    cancellationInfo: InterviewCancellationNotificationInfo,
  ): Promise<boolean> {
    const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(cancellationInfo.botImId);
    const card = this.bookingCardRenderer.buildInterviewCancellationCard({
      ...cancellationInfo,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.privateChatChannel.send(card);
    if (success) {
      this.logger.log(`面试预约取消通知已发送: ${cancellationInfo.candidateName ?? '-'}`);
    } else {
      this.logger.warn(`面试预约取消通知发送失败: ${cancellationInfo.candidateName ?? '-'}`);
    }
    return success;
  }
}
