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
      `系统已自动暂停托管，请人工介入处理。`,
      `风险类型：${payload.riskLabel}`,
      `命中原因：${payload.reason}`,
      `当前消息：${payload.currentMessageContent}`,
      `**聊天上下文（最近10条）**\n${this.formatRecentMessages(payload)}`,
      `**候选人信息**\n${this.formatCandidateInfo(payload)}`,
      `**岗位信息**\n${this.formatJobInfo(payload)}`,
      `**系统动作**\n已暂停托管\nAI 已停止回复\n处理完成后请手动恢复托管`,
      `通知时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    ];

    return this.cardBuilder.buildMarkdownCard({
      title: '交流异常',
      content: sections.join('\n\n'),
      color: 'red',
      atUsers: payload.atUsers,
      atAll: payload.atAll,
    });
  }

  private formatRecentMessages(payload: ConversationRiskNotificationPayload): string {
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

  private formatCandidateInfo(payload: ConversationRiskNotificationPayload): string {
    const interviewInfo = payload.sessionState?.facts?.interview_info;
    const preferences = payload.sessionState?.facts?.preferences;
    const lines = [
      payload.contactName ? `昵称：${payload.contactName}` : null,
      interviewInfo?.name ? `姓名：${interviewInfo.name}` : null,
      interviewInfo?.phone ? `电话：${interviewInfo.phone}` : null,
      interviewInfo?.gender ? `性别：${interviewInfo.gender}` : null,
      interviewInfo?.age ? `年龄：${interviewInfo.age}` : null,
      preferences?.city ? `城市：${preferences.city}` : null,
      preferences?.district?.length ? `区域：${preferences.district.join('、')}` : null,
      preferences?.position?.length ? `意向岗位：${preferences.position.join('、')}` : null,
      `会话ID：${payload.chatId}`,
      `暂停ID：${payload.pausedUserId}`,
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
      return '暂无岗位信息';
    }

    return presentedJobs
      .slice(0, 3)
      .map((job, index) => {
        const parts = [job.brandName, job.storeName, job.jobName].filter(Boolean).join(' / ');
        return `${index + 1}. ${parts || `岗位ID ${job.jobId}`}`;
      })
      .join('\n');
  }
}
