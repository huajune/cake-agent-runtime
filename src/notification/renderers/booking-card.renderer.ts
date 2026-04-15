import { Injectable } from '@nestjs/common';
import { FeishuReceiver } from '@infra/feishu/constants/receivers';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';

export interface InterviewBookingNotificationPayload {
  contactName?: string;
  candidateName: string;
  phone: string;
  genderLabel?: string;
  ageText?: string;
  botUserName?: string;
  brandName?: string;
  storeName?: string;
  jobName?: string;
  jobId?: number;
  interviewTime: string;
  toolOutput: Record<string, unknown>;
  atUsers?: FeishuReceiver[];
  atAll?: boolean;
}

@Injectable()
export class BookingCardRenderer {
  constructor(private readonly cardBuilder: FeishuCardBuilderService) {}

  buildInterviewBookingCard(payload: InterviewBookingNotificationPayload): {
    isFailure: boolean;
    card: Record<string, unknown>;
  } {
    const toolOutput = payload.toolOutput;
    const isFailure = toolOutput.success === false;
    const resultMessage = this.pickString(toolOutput.message, toolOutput.notice);
    const bookingId = this.pickString(toolOutput.booking_id);
    const failureReason = this.pickString(toolOutput.error);
    const failureDetails = this.stringifyErrorList(toolOutput.errorList);
    const sections: string[] = [];

    if (isFailure) {
      sections.push(
        `候选人 ${payload.candidateName} 预约失败，请尽快跟进处理。\n⚠️ 该用户已暂停托管`,
      );
    }

    const candidateLines = [
      payload.contactName ? `微信昵称：${payload.contactName}` : null,
      `姓名：${payload.candidateName}`,
      `电话：${payload.phone}`,
      payload.genderLabel ? `性别：${payload.genderLabel}` : null,
      payload.ageText ? `年龄：${payload.ageText}` : null,
      payload.botUserName ? `托管账号：${payload.botUserName}` : null,
    ].filter((line): line is string => Boolean(line));
    sections.push(`**候选人信息**\n${candidateLines.join('\n')}`);

    const interviewLines = [
      payload.brandName ? `品牌：${payload.brandName}` : null,
      payload.storeName ? `门店：${payload.storeName}` : null,
      payload.jobName ? `面试岗位：${payload.jobName}` : null,
      `面试时间：${this.formatInterviewTimeForDisplay(payload.interviewTime)}`,
      payload.jobId ? `岗位ID：${payload.jobId}` : null,
      bookingId ? `预约编号：${bookingId}` : null,
    ].filter((line): line is string => Boolean(line));
    sections.push(`**岗位信息**\n${interviewLines.join('\n')}`);

    if (isFailure) {
      const resultLines = [
        failureReason ? `原因：${failureReason}` : null,
        failureDetails ? `明细：${failureDetails}` : null,
        resultMessage ? `返回信息：${resultMessage}` : null,
      ].filter((line): line is string => Boolean(line));
      if (resultLines.length > 0) {
        sections.push(`**失败详情**\n${resultLines.join('\n')}`);
      }
    } else if (resultMessage) {
      sections.push(`结果：${resultMessage}`);
    }

    sections.push(`通知时间：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);

    return {
      isFailure,
      card: this.cardBuilder.buildMarkdownCard({
        title: isFailure ? '⚠️ 面试预约失败' : '🎉 面试预约成功',
        content: sections.join('\n\n'),
        color: isFailure ? 'red' : 'green',
        atUsers: payload.atUsers,
        atAll: payload.atAll,
      }),
    };
  }

  private stringifyErrorList(value: unknown): string | undefined {
    if (!Array.isArray(value) || value.length === 0) return undefined;

    const text = value
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        try {
          return JSON.stringify(item);
        } catch {
          return String(item);
        }
      })
      .filter(Boolean)
      .join('；');

    return text || undefined;
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private formatInterviewTimeForDisplay(value: string): string {
    const normalized = value.trim();
    const withSeconds = normalized.match(/^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}):\d{2}$/);
    if (withSeconds) return withSeconds[1];
    return normalized;
  }
}
