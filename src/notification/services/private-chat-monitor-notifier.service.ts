import { actionDigest } from '@biz/action-execution/action-identity';
import { Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ActionExecutorService } from '@biz/action-execution/action-executor.service';
import { ActionRecoveryRegistry } from '@biz/action-execution/action-recovery.registry';
import type { ToolSessionContext } from '@shared-types/tool.types';
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
export class PrivateChatMonitorNotifierService implements OnModuleInit {
  private readonly logger = new Logger(PrivateChatMonitorNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly bookingCardRenderer: BookingCardRenderer,
    private readonly hostingMemberConfig: HostingMemberConfigService,
    @Optional() private readonly actions?: ActionExecutorService,
    @Optional() private readonly recovery?: ActionRecoveryRegistry,
  ) {}

  onModuleInit(): void {
    for (const kind of ['booking_notification', 'cancellation_notification']) {
      this.recovery?.register(kind, {
        reconcile: async () => ({
          status: 'unknown',
          evidence: {
            kind: 'indeterminate',
            requestTerminated: false,
            detail: 'webhook_has_no_verified_request_lookup',
          },
        }),
      });
    }
  }

  async notifyInterviewBookingResult(
    bookingInfo: InterviewBookingNotificationInfo,
    session?: ToolSessionContext,
  ): Promise<boolean> {
    const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(bookingInfo.botImId);
    const { isFailure, card } = this.bookingCardRenderer.buildInterviewBookingCard({
      ...bookingInfo,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.sendRecorded(
      'booking_notification',
      card,
      session,
      bookingInfo.botImId,
    );
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
    session?: ToolSessionContext,
  ): Promise<boolean> {
    const receiver = await this.hostingMemberConfig.resolveFeishuReceiver(cancellationInfo.botImId);
    const card = this.bookingCardRenderer.buildInterviewCancellationCard({
      ...cancellationInfo,
      ...(receiver ? { atUsers: [receiver] } : { atAll: true }),
    });

    const success = await this.sendRecorded(
      'cancellation_notification',
      card,
      session,
      cancellationInfo.botImId,
    );
    if (success) {
      this.logger.log(`面试预约取消通知已发送: ${cancellationInfo.candidateName ?? '-'}`);
    } else {
      this.logger.warn(`面试预约取消通知发送失败: ${cancellationInfo.candidateName ?? '-'}`);
    }
    return success;
  }

  private async sendRecorded(
    kind: string,
    card: Record<string, unknown>,
    session?: ToolSessionContext,
    botImId?: string,
  ): Promise<boolean> {
    if (botImId && session?.botImId && botImId.trim() !== session.botImId.trim()) {
      this.logger.error('私聊通知账号与会话账号不一致，拒绝发送');
      return false;
    }
    const routeBotId =
      session?.corpId === 'test' || session?.corpId === 'debug'
        ? undefined
        : (botImId ?? session?.botImId);
    if (!session) return this.privateChatChannel.send(card, routeBotId);
    if (!this.actions) {
      this.logger.error('Notification action executor missing');
      return false;
    }
    const turn = session.logicalTurnId ?? session.turnId ?? '';
    const result = await this.actions.execute(
      {
        corpId: session.corpId,
        accountId: session.botImId ?? session.botUserId ?? '',
        chatId: session.chatId ?? session.sessionId,
        logicalTurnId: turn,
        intentId: turn,
        kind,
        target: `${kind}:${session.chatId ?? session.sessionId}:${actionDigest(card)}`,
        parameters: { card },
        occurredAt: session.inputOccurredAt ?? new Date().toISOString(),
        identityReliable: Boolean(session.logicalTurnId && session.inputOccurredAt),
      },
      {
        dispatch: async (_requestId, mode) => {
          const accepted =
            mode === 'execute'
              ? await this.privateChatChannel.sendOnce(card, routeBotId)
              : await this.privateChatChannel.send(card, routeBotId);
          return accepted
            ? {
                status: 'succeeded',
                result: true,
                evidence: {
                  kind: 'accepted',
                  requestTerminated: true,
                  detail: 'webhook_accepted_not_recipient_read',
                },
              }
            : {
                status: 'unknown',
                result: false,
                evidence: { kind: 'indeterminate', requestTerminated: false },
              };
        },
      },
    );
    return result.status === 'succeeded';
  }
}
