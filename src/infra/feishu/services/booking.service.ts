import { Injectable, Logger } from '@nestjs/common';
import { FeishuWebhookService } from './webhook.service';
import { InterviewBookingInfo } from '../interfaces/interface';

/**
 * 飞书面试预约通知服务
 * 处理面试预约成功/失败的通知
 */
@Injectable()
export class FeishuBookingService {
  private readonly logger = new Logger(FeishuBookingService.name);

  constructor(private readonly webhookService: FeishuWebhookService) {}

  /**
   * 发送面试预约结果通知
   * @param bookingInfo 预约信息
   * @returns 是否发送成功
   */
  async sendBookingNotification(bookingInfo: InterviewBookingInfo): Promise<boolean> {
    try {
      const time = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      const toolOutput =
        bookingInfo.toolOutput && typeof bookingInfo.toolOutput === 'object'
          ? bookingInfo.toolOutput
          : undefined;
      const isFailure = toolOutput?.success === false;
      const resultMessage = this.pickString(toolOutput?.message, toolOutput?.notice);
      const bookingId = this.pickString(toolOutput?.booking_id);
      const failureReason = this.pickString(toolOutput?.error);
      const failureDetails = this.stringifyErrorList(toolOutput?.errorList);
      const statusText = isFailure ? '失败' : '成功';
      const summaryLine = isFailure
        ? `候选人${bookingInfo.candidateName ? ` ${bookingInfo.candidateName}` : ''} 预约失败，请尽快跟进处理。`
        : `候选人${bookingInfo.candidateName ? ` ${bookingInfo.candidateName}` : ''} 已完成面试预约。`;

      const sections: string[] = [];
      sections.push(`**摘要**\n${summaryLine}`);

      const candidateLines: string[] = [];
      if (bookingInfo.candidateName) candidateLines.push(`候选人：${bookingInfo.candidateName}`);
      if (bookingInfo.contactInfo) {
        candidateLines.push(`联系方式：${this.maskPhone(bookingInfo.contactInfo)}`);
      }
      if (bookingInfo.managerName) candidateLines.push(`招募经理：${bookingInfo.managerName}`);
      if (candidateLines.length > 0) {
        sections.push(`**候选人信息**\n${candidateLines.join('\n')}`);
      }

      const interviewLines: string[] = [];
      if (bookingInfo.brandName) interviewLines.push(`品牌：${bookingInfo.brandName}`);
      if (bookingInfo.storeName) interviewLines.push(`门店：${bookingInfo.storeName}`);
      if (bookingInfo.interviewTime) interviewLines.push(`面试时间：${bookingInfo.interviewTime}`);
      if (interviewLines.length > 0) {
        sections.push(`**面试安排**\n${interviewLines.join('\n')}`);
      }

      const resultLines: string[] = [`预约状态：${statusText}`];
      if (resultMessage) resultLines.push(`处理结果：${resultMessage}`);
      if (bookingId) resultLines.push(`预约编号：${bookingId}`);
      if (failureReason) resultLines.push(`失败原因：${failureReason}`);
      if (failureDetails) resultLines.push(`失败明细：${failureDetails}`);
      sections.push(`**执行结果**\n${resultLines.join('\n')}`);

      const metaLines: string[] = [`通知时间：${time}`];
      if (bookingInfo.chatId) metaLines.push(`会话 ID：${bookingInfo.chatId}`);
      if (bookingInfo.userName) metaLines.push(`候选人来源：${bookingInfo.userName}`);
      sections.push(`**附加信息**\n${metaLines.join('\n')}`);

      const title = isFailure ? '⚠️ 面试预约失败' : '🎉 面试预约成功';
      const color = isFailure ? 'red' : 'green';
      const card = this.webhookService.buildCardWithAtAll(title, sections.join('\n\n'), color);

      // 发送
      const success = await this.webhookService.sendMessage('INTERVIEW_BOOKING', card);

      if (success) {
        this.logger.log(
          `面试预约${isFailure ? '失败' : '成功'}通知已发送: ${
            bookingInfo.candidateName || '未知候选人'
          } - ${bookingInfo.brandName || '未知品牌'}`,
        );
      } else {
        this.logger.warn(`面试预约${isFailure ? '失败' : '成功'}通知发送失败`);
      }

      return success;
    } catch (error) {
      this.logger.error(`面试预约通知发送异常: ${error.message}`);
      return false;
    }
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

  private maskPhone(phone: string): string {
    const trimmed = phone.trim();
    if (!/^\d{11}$/.test(trimmed)) return trimmed;
    return `${trimmed.slice(0, 3)}****${trimmed.slice(-4)}`;
  }
}
