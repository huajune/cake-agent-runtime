import { Injectable } from '@nestjs/common';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { unwrapSessionFactValue } from '@memory/types/session-facts.types';
import { GeneralHandoffNotificationPayload } from '../types/general-handoff-notification.types';

/**
 * 时效敏感的转人工原因：候选人可能已在途/正在等待，超时未跟进直接丢单。
 * （改约类 24h 真人跟进率长期偏低，卡片顶部显式标急以对齐处理优先级。）
 */
const URGENT_REASON_CODES = new Set(['modify_appointment', 'no_reception', 'booking_conflict']);

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
    const isUrgent = payload.reasonCode ? URGENT_REASON_CODES.has(payload.reasonCode) : false;
    const sections = [
      payload.isTest ? '> 测试ing（来自回归批次，无需 @ 招募经理）' : null,
      isUrgent
        ? `> <font color='red'>**⏱ 时效敏感**：候选人可能已在途或正在等待，请尽快跟进</font>`
        : null,
      this.formatHighlightedFocus(payload.reason, payload.actionAdvice),
      this.formatJobDataGap(payload),
      `**当前消息**：${payload.currentMessageContent || '-'}`,
      `**聊天上下文（最近10条）**\n${this.formatRecentMessages(payload)}`,
      `**候选人信息**\n${this.formatCandidateInfo(payload)}`,
      '处理完请到 Web 托管后台手动恢复托管。',
      this.formatDiagnostics(payload.diagnostics),
    ].filter((line): line is string => Boolean(line));

    const baseTitle = payload.titleOverride ?? `🚨 候选人需人工介入 · ${payload.alertLabel}`;
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

  /**
   * 岗位数据缺口区块（salary_admin_inquiry）：候选人问到而岗位字段没有答案的
   * 信息点 + 当前焦点岗位。运营据此可直接去岗位库补录缺失字段。
   */
  private formatJobDataGap(payload: GeneralHandoffNotificationPayload): string | null {
    const missing = (payload.missingJobInfo ?? []).map((item) => item.trim()).filter(Boolean);
    if (missing.length === 0) return null;

    const focusJob = payload.sessionState?.currentFocusJob;
    const jobLabel = focusJob
      ? `${
          focusJob.jobName ||
          [focusJob.brandName, focusJob.storeName].filter(Boolean).join('-') ||
          '未知岗位'
        }（jobId ${focusJob.jobId}）`
      : '未定位到焦点岗位（见聊天上下文）';

    return [
      '**📋 岗位数据缺口（可在岗位库补录）**',
      `岗位：${jobLabel}`,
      `缺失信息：${missing.join('、')}`,
    ].join('\n');
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
      payload.workOrderId != null ? `关联工单：${payload.workOrderId}` : null,
      payload.botUserName?.trim() ? `托管账号：${payload.botUserName.trim()}` : null,
      `会话ID：${payload.chatId}`,
      `暂停ID：${payload.pausedUserId}`,
    ].filter((line): line is string => Boolean(line));

    return lines.join('\n');
  }

  private formatDiagnostics(diagnostics?: Record<string, unknown>): string | null {
    if (!diagnostics || Object.keys(diagnostics).length === 0) return null;
    return `**诊断载荷**:\n\`\`\`json\n${JSON.stringify(diagnostics, null, 2)}\n\`\`\``;
  }
}
