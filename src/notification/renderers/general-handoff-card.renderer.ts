import { Injectable } from '@nestjs/common';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { unwrapSessionFactValue } from '@memory/types/session-facts.types';
import { GeneralHandoffNotificationPayload } from '../types/general-handoff-notification.types';

@Injectable()
export class GeneralHandoffCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildCard(
    payload: GeneralHandoffNotificationPayload & {
      isTest?: boolean;
      atUsers?: FeishuReceiver[];
      atAll?: boolean;
    },
  ): Record<string, unknown> {
    const sections = [
      payload.isTest ? '> 测试ing（来自回归批次，无需 @ 招募经理）' : null,
      this.formatHighlightedFocus(payload.reason, payload.actionAdvice),
      `**当前消息**：${payload.currentMessageContent || '-'}`,
      `**聊天上下文（最近10条）**\n${this.formatRecentMessages(payload)}`,
      `**候选人信息**\n${this.formatCandidateInfo(payload)}`,
      '处理完请到 Web 托管后台手动恢复托管。',
    ].filter((line): line is string => Boolean(line));

    const baseTitle = `🚨 候选人需人工介入 · ${payload.alertLabel}`;
    return this.cardBuilder.buildMarkdownCard({
      title: payload.isTest ? `${baseTitle} · 测试ing` : baseTitle,
      content: sections.join('\n\n'),
      color: 'red',
      atUsers: payload.atUsers,
      atAll: payload.atAll,
    });
  }

  private formatHighlightedFocus(reason: string, actionAdvice?: string): string {
    const lines = [`> <font color='red'>**命中原因**：${reason}</font>`];
    const trimmedAdvice = actionAdvice?.trim();
    if (trimmedAdvice) {
      lines.push(`> <font color='red'>**建议动作**：${trimmedAdvice}</font>`);
    }
    return lines.join('\n');
  }

  private formatRecentMessages(payload: GeneralHandoffNotificationPayload): string {
    if (payload.recentMessages.length === 0) return '暂无上下文';

    return payload.recentMessages
      .slice(-10)
      .map((message) => {
        const roleLabel = message.role === 'user' ? '候选人' : '招募经理';
        const timeLabel = new Intl.DateTimeFormat('zh-CN', {
          timeZone: 'Asia/Shanghai',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        }).format(new Date(message.timestamp));
        return `[${timeLabel} ${roleLabel}] ${message.content}`;
      })
      .join('\n');
  }

  private formatCandidateInfo(payload: GeneralHandoffNotificationPayload): string {
    const interviewInfo = payload.sessionState?.facts?.interview_info;
    const name = unwrapSessionFactValue(interviewInfo?.name);
    const phone = unwrapSessionFactValue(interviewInfo?.phone);
    const age = unwrapSessionFactValue(interviewInfo?.age);
    const lines = [
      payload.contactName ? `微信昵称：${payload.contactName}` : null,
      name ? `姓名：${name}` : null,
      phone ? `电话：${phone}` : null,
      age ? `年龄：${age}` : null,
      payload.botUserName?.trim() ? `托管账号：${payload.botUserName.trim()}` : null,
      `会话ID：${payload.chatId}`,
      `暂停ID：${payload.pausedUserId}`,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }
}
