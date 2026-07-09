import { Injectable, Logger, Optional } from '@nestjs/common';
import { AlertLevel } from '@enums/alert.enum';
import { FEISHU_RECEIVER_USERS, FeishuReceiver } from '@infra/feishu/constants/receivers';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { FeishuOpsChannel } from '../channels/feishu-ops.channel';
import { AlertNotifierService } from './alert-notifier.service';
import {
  GroupTaskExecutionDetail,
  GroupTaskExecutionError,
  OpsCardRenderer,
} from '../renderers/ops-card.renderer';

@Injectable()
export class OpsNotifierService {
  private readonly logger = new Logger(OpsNotifierService.name);

  constructor(
    private readonly opsChannel: FeishuOpsChannel,
    private readonly opsCardRenderer: OpsCardRenderer,
    private readonly hostingMemberConfig: HostingMemberConfigService,
    @Optional() private readonly alertNotifier?: AlertNotifierService,
  ) {}

  async sendGroupTaskPreview(params: {
    groupName: string;
    tag: string;
    city: string;
    industry?: string;
    typeName: string;
    message: string;
    dryRun: boolean;
  }): Promise<boolean> {
    const card = this.opsCardRenderer.buildGroupTaskPreviewCard(params);

    if (params.dryRun) {
      await this.opsChannel.sendOrThrow(card);
      return true;
    }

    const sent = await this.opsChannel.send(card);
    if (!sent) {
      this.logger.error(
        `[运营通知] 飞书消息通知群发送失败: ${params.typeName} -> ${params.groupName}`,
      );
    }
    return sent;
  }

  async sendGroupTaskReport(params: {
    typeName: string;
    dryRun: boolean;
    totalGroups: number;
    successCount: number;
    failedCount: number;
    skippedCount: number;
    durationSeconds: number;
    details: GroupTaskExecutionDetail[];
    errors: GroupTaskExecutionError[];
    atUsers?: FeishuReceiver[];
  }): Promise<void> {
    const card = this.opsCardRenderer.buildGroupTaskReportCard(params);
    await this.opsChannel.sendOrThrow(card);
  }

  async sendGroupFullAlert(params: {
    city: string;
    industry?: string;
    memberLimit: number;
    groups: Array<{ name: string; memberCount?: number }>;
  }): Promise<boolean> {
    const card = this.opsCardRenderer.buildGroupFullAlertCard({
      ...params,
      atUsers: [FEISHU_RECEIVER_USERS.GAO_YAQI],
    });
    return this.opsChannel.send(card);
  }

  /**
   * 接客 bot 拉群被接口拒绝告警。
   *
   * 与"群满"告警不同——这是 bot 与群的成员关系出问题（典型 errcode=400400
   * "room not found"），需要运维去企微后台把对应招募经理 bot 拉进缺失的群里。
   */
  async sendInviteRejectedAlert(params: {
    city: string;
    industry?: string;
    chatBotImId?: string;
    chatBotUserId?: string;
    scope?: {
      corpId?: string;
      userId?: string;
      contactName?: string;
      chatId?: string;
      sessionId?: string;
      messageId?: string;
    };
    rejectedGroups: Array<{
      name: string;
      imRoomId: string;
      ownerBotImId?: string;
      ownerBotUserId?: string;
      error?: string;
    }>;
  }): Promise<boolean> {
    // 同时 @ 接客 bot 负责人和 GAO_YAQI（群主固定为琪琪），让两边都能跟进
    const atUsers = new Set<FeishuReceiver>([FEISHU_RECEIVER_USERS.GAO_YAQI]);
    if (params.chatBotImId) {
      const chatReceiver = await this.hostingMemberConfig.resolveFeishuReceiver(params.chatBotImId);
      if (chatReceiver) atUsers.add(chatReceiver);
    }
    const card = this.opsCardRenderer.buildInviteRejectedAlertCard({
      ...params,
      atUsers: Array.from(atUsers),
    });
    const delivered = await this.opsChannel.send(card);

    void this.alertNotifier
      ?.sendAlert({
        code: 'wecom.invite_to_group.api_rejected',
        severity: AlertLevel.WARNING,
        summary: `接客 bot 拉群被接口拒绝：${params.city}${
          params.industry ? `/${params.industry}` : ''
        }`,
        source: {
          subsystem: 'wecom',
          component: 'invite_to_group',
          action: 'add_member_enterprise',
          trigger: 'tool',
        },
        scope: params.scope,
        impact: {
          requiresHumanIntervention: true,
        },
        diagnostics: {
          errorMessage: `企业级拉群接口拒绝 ${params.rejectedGroups.length} 个候选群`,
          payload: {
            city: params.city,
            industry: params.industry,
            chatBotImId: params.chatBotImId,
            chatBotUserId: params.chatBotUserId,
            rejectedGroups: params.rejectedGroups,
            opsCardDelivered: delivered,
          },
        },
        routing: { atUsers: Array.from(atUsers) },
        dedupe: {
          key: [
            'wecom.invite_to_group.api_rejected',
            params.city,
            params.industry ?? '-',
            params.chatBotImId ?? '-',
            params.rejectedGroups
              .map((group) => group.imRoomId)
              .sort()
              .join(','),
          ].join(':'),
        },
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`[拉群被拒] 统一异常告警发送失败: ${message}`);
      });

    return delivered;
  }
}
