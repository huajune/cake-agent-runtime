import { Injectable } from '@nestjs/common';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { OnboardFollowupNotificationPayload } from '../types/onboard-followup-notification.types';

@Injectable()
export class OnboardFollowupCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildCard(
    payload: OnboardFollowupNotificationPayload & { atUsers?: FeishuReceiver[]; atAll?: boolean },
  ): Record<string, unknown> {
    const sections = [
      `风险类型：${payload.alertLabel}`,
      `命中原因：${payload.reason}`,
      `当前消息：${payload.currentMessageContent}`,
      `**聊天上下文（最近10条）**\n${this.formatRecentMessages(payload)}`,
      `**候选人信息**\n${this.formatCandidateInfo(payload)}`,
      `**预约信息**\n${this.formatCaseInfo(payload)}`,
      '处理完请到 Web 托管后台手动恢复托管。',
    ];

    return this.cardBuilder.buildMarkdownCard({
      title: '🚨 面试及上岗对接 · 需要人工介入',
      content: sections.join('\n\n'),
      color: 'red',
      atUsers: payload.atUsers,
      atAll: payload.atAll,
    });
  }

  private formatRecentMessages(payload: OnboardFollowupNotificationPayload): string {
    if (payload.recentMessages.length === 0) {
      return '暂无上下文';
    }

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

  private formatCandidateInfo(payload: OnboardFollowupNotificationPayload): string {
    const interviewInfo = payload.sessionState?.facts?.interview_info;
    const lines = [
      payload.contactName ? `微信昵称：${payload.contactName}` : null,
      interviewInfo?.name ? `姓名：${interviewInfo.name}` : null,
      interviewInfo?.phone ? `电话：${interviewInfo.phone}` : null,
      interviewInfo?.age ? `年龄：${interviewInfo.age}` : null,
      payload.botUserName?.trim() ? `托管账号：${payload.botUserName.trim()}` : null,
      `会话ID：${payload.chatId}`,
      `暂停ID：${payload.pausedUserId}`,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }

  private formatCaseInfo(payload: OnboardFollowupNotificationPayload): string {
    const recruitmentCase = payload.recruitmentCase;
    const lines = [
      recruitmentCase.brand_name ? `品牌：${recruitmentCase.brand_name}` : null,
      recruitmentCase.store_name ? `门店：${recruitmentCase.store_name}` : null,
      recruitmentCase.job_name ? `岗位：${recruitmentCase.job_name}` : null,
      recruitmentCase.interview_time ? `面试时间：${recruitmentCase.interview_time}` : null,
      recruitmentCase.booking_id ? `预约编号：${recruitmentCase.booking_id}` : null,
      recruitmentCase.followup_window_ends_at
        ? `跟进窗口截止：${new Date(recruitmentCase.followup_window_ends_at).toLocaleString(
            'zh-CN',
            {
              timeZone: 'Asia/Shanghai',
            },
          )}`
        : null,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }
}
