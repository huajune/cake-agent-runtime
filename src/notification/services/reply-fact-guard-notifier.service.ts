import { Injectable, Logger } from '@nestjs/common';
import {
  BOT_TO_RECEIVER,
  FEISHU_RECEIVER_USERS,
  FeishuReceiver,
} from '@infra/feishu/constants/receivers';
import { FeishuPrivateChatChannel } from '../channels/feishu-private-chat.channel';
import { OpsCardRenderer } from '../renderers/ops-card.renderer';

/**
 * Reply 事实矛盾告警（来自 ReplyFactGuardService phase 1）。
 *
 * Agent 在确认轮自由发挥（如本轮没调 invite_to_group 却声明"群已满"/"群里发你"），
 * 结构性背离 tool 真实结果。本告警仅观察，不改写回复——用于积累样本判断
 * 关键词规则准确率，决定是否升级到 phase 2 改写。
 *
 * 投递渠道：与 risk / handoff 等对话级介入告警一致，走私聊群（PRIVATE_CHAT_MONITOR），
 * 不与运营群（MESSAGE_NOTIFICATION，群任务执行流）混发。
 */
@Injectable()
export class ReplyFactGuardNotifierService {
  private readonly logger = new Logger(ReplyFactGuardNotifierService.name);

  constructor(
    private readonly privateChatChannel: FeishuPrivateChatChannel,
    private readonly opsCardRenderer: OpsCardRenderer,
  ) {}

  async notifyContradiction(params: {
    chatId?: string;
    userId?: string;
    traceId?: string;
    contactName?: string;
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
    const sent = await this.privateChatChannel.send(card);
    if (!sent) {
      this.logger.error(`[ReplyFactGuard] 飞书告警发送失败: chatId=${params.chatId ?? '-'}`);
    }
    return sent;
  }
}
