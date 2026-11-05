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
import {
  ACTION_EVIDENCE_KIND,
  ACTION_KIND,
  ACTION_MODE,
  ACTION_STATE,
} from '@shared-types/action-execution.contract';

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
    for (const kind of [ACTION_KIND.BOOKING_NOTIFICATION, ACTION_KIND.CANCELLATION_NOTIFICATION]) {
      this.recovery?.register(kind, {
        reconcile: async () => ({
          status: ACTION_STATE.UNKNOWN,
          evidence: {
            kind: ACTION_EVIDENCE_KIND.INDETERMINATE,
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
      ACTION_KIND.BOOKING_NOTIFICATION,
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
      ACTION_KIND.CANCELLATION_NOTIFICATION,
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
    kind: typeof ACTION_KIND.BOOKING_NOTIFICATION | typeof ACTION_KIND.CANCELLATION_NOTIFICATION,
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
            mode === ACTION_MODE.EXECUTE
              ? await this.privateChatChannel.sendOnce(card, routeBotId)
              : await this.privateChatChannel.send(card, routeBotId);
          return accepted
            ? {
                status: ACTION_STATE.SUCCEEDED,
                result: true,
                evidence: {
                  kind: ACTION_EVIDENCE_KIND.ACCEPTED,
                  requestTerminated: true,
                  detail: 'webhook_accepted_not_recipient_read',
                },
              }
            : {
                status: ACTION_STATE.UNKNOWN,
                result: false,
                evidence: { kind: ACTION_EVIDENCE_KIND.INDETERMINATE, requestTerminated: false },
              };
        },
      },
    );
    return result.status === ACTION_STATE.SUCCEEDED;
  }
}
