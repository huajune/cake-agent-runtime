import { Injectable } from '@nestjs/common';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { ConversationRiskNotificationPayload } from '../types/conversation-risk-notification.types';

@Injectable()
export class ConversationRiskCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildConversationRiskCard(
    payload: ConversationRiskNotificationPayload & { atUsers?: FeishuReceiver[]; atAll?: boolean },
  ): Record<string, unknown> {
    const sections = [
      this.formatOverview(payload),
      this.buildSection('聊天上下文（最近10条）', this.formatRecentMessages(payload)),
      this.buildSection('候选人信息', this.formatCandidateInfo(payload)),
      this.buildSection('岗位信息', this.formatJobInfo(payload)),
      this.buildSection(
        '系统动作',
        ['- 已暂停托管', '- AI 已停止回复', '- 处理完成后请手动恢复托管'].join('\n'),
      ),
      `通知时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ].filter((section): section is string => Boolean(section));

    return this.cardBuilder.buildMarkdownCard({
      title: '交流异常 · 人工介入',
      content: sections.join('\n\n'),
      color: 'red',
      atUsers: payload.atUsers,
      atAll: payload.atAll,
    });
  }

  private formatOverview(payload: ConversationRiskNotificationPayload): string {
    const lines = ['系统已自动暂停托管，请人工介入处理。', `风险类型：${payload.riskLabel}`];

    if (
      payload.summary &&
      payload.summary.trim() &&
      payload.summary.trim() !== payload.reason.trim()
    ) {
      lines.push(`风险摘要：${payload.summary.trim()}`);
    }

    lines.push(`命中原因：${payload.reason}`);
    lines.push(`当前消息：${this.formatQuotedText(payload.currentMessageContent)}`);

    return lines.join('\n');
  }

  private formatRecentMessages(payload: ConversationRiskNotificationPayload): string {
    if (payload.recentMessages.length === 0) {
      return '';
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
        return `[${timeLabel} ${roleLabel}] ${this.sanitizeInlineText(message.content, 120)}`;
      })
      .join('\n');
  }

  private formatCandidateInfo(payload: ConversationRiskNotificationPayload): string {
    const interviewInfo = payload.sessionState?.facts?.interview_info;
    const preferences = payload.sessionState?.facts?.preferences;
    const normalizedContactName = payload.contactName?.trim();
    const hasReadableNickname =
      normalizedContactName &&
      !/^[0-9]{8,}$/.test(normalizedContactName) &&
      !/^[0-9a-f-]{24,}$/i.test(normalizedContactName);
    const lines = [
      hasReadableNickname ? `昵称：${normalizedContactName}` : null,
      interviewInfo?.name && interviewInfo.name !== normalizedContactName
        ? `姓名：${interviewInfo.name}`
        : null,
      interviewInfo?.phone ? `电话：${interviewInfo.phone}` : null,
      interviewInfo?.gender ? `性别：${interviewInfo.gender}` : null,
      interviewInfo?.age ? `年龄：${interviewInfo.age}` : null,
      preferences?.city ? `城市：${preferences.city}` : null,
      preferences?.district?.length ? `区域：${preferences.district.join('、')}` : null,
      preferences?.position?.length ? `意向岗位：${preferences.position.join('、')}` : null,
      `会话ID：${payload.chatId}`,
      payload.pausedUserId !== payload.chatId ? `暂停目标ID：${payload.pausedUserId}` : null,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }

  private formatJobInfo(payload: ConversationRiskNotificationPayload): string {
    const currentFocusJob = payload.sessionState?.currentFocusJob;
    if (currentFocusJob) {
      return [
        currentFocusJob.brandName ? `品牌：${currentFocusJob.brandName}` : null,
        currentFocusJob.storeName ? `门店：${currentFocusJob.storeName}` : null,
        currentFocusJob.jobName ? `岗位：${currentFocusJob.jobName}` : null,
        currentFocusJob.salaryDesc ? `薪资：${currentFocusJob.salaryDesc}` : null,
        currentFocusJob.storeAddress ? `地址：${currentFocusJob.storeAddress}` : null,
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    }

    const presentedJobs = payload.sessionState?.presentedJobs ?? [];
    if (presentedJobs.length === 0) {
      return '';
    }

    return presentedJobs
      .slice(0, 3)
      .map((job, index) => {
        const parts = [job.brandName, job.storeName, job.jobName].filter(Boolean).join(' / ');
        return `${index + 1}. ${parts || `岗位ID ${job.jobId}`}`;
      })
      .join('\n');
  }

  private buildSection(title: string, content: string): string {
    if (!content.trim()) {
      return '';
    }

    return `**${title}**\n${content}`;
  }

  private formatQuotedText(text: string): string {
    return text
      .split('\n')
      .map((line) => `> ${line.trim()}`)
      .join('\n');
  }

  private sanitizeInlineText(text: string, maxLength: number): string {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, maxLength)}...`;
  }
}
