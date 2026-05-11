import { Injectable, Logger } from '@nestjs/common';
import {
  BOT_TO_RECEIVER,
  FEISHU_RECEIVER_USERS,
  FeishuReceiver,
} from '@infra/feishu/constants/receivers';
import { FeishuOpsChannel } from '../channels/feishu-ops.channel';
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
      const chatReceiver = BOT_TO_RECEIVER[params.chatBotImId];
      if (chatReceiver) atUsers.add(chatReceiver);
    }
    const card = this.opsCardRenderer.buildInviteRejectedAlertCard({
      ...params,
      atUsers: Array.from(atUsers),
    });
    return this.opsChannel.send(card);
  }

  /**
   * Reply 事实矛盾告警（来自 ReplyFactGuardService phase 1）。
   *
   * Agent 在确认轮自由发挥（如本轮没调 invite_to_group 却声明"群已满"），
   * 结构性背离 tool 真实结果。本告警仅观察，不改写回复——用于积累样本判断
   * 关键词规则准确率，决定是否升级到 phase 2 改写。
   */
  async sendReplyFactContradictionAlert(params: {
    chatId?: string;
    userId?: string;
    botImId?: string;
    botUserName?: string;
    replyPreview: string;
    contradictions: Array<{ ruleId: string; label: string }>;
    toolNames: string[];
  }): Promise<boolean> {
    const atUsers = new Set<FeishuReceiver>([FEISHU_RECEIVER_USERS.GAO_YAQI]);
    if (params.botImId) {
      const chatReceiver = BOT_TO_RECEIVER[params.botImId];
      if (chatReceiver) atUsers.add(chatReceiver);
    }
    const card = this.opsCardRenderer.buildReplyFactContradictionAlertCard({
      ...params,
      atUsers: Array.from(atUsers),
    });
    return this.opsChannel.send(card);
  }
}
