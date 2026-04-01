import { Injectable, Logger } from '@nestjs/common';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';
import { BookingService } from '@biz/message/services/booking.service';
import { InterviewBookingInfo } from '@infra/feishu/interfaces/interface';
import type { AgentInvokeResult } from '@wecom/message/message.types';

type BookingToolCall = NonNullable<AgentInvokeResult['toolCalls']>[number];

/**
 * 预约结果检测服务 (Business Logic)
 *
 * 职责：
 * 1. 优先从工具结果识别预约成功/失败
 * 2. 异步发送飞书通知
 * 3. 更新成功预约统计数据表
 */
@Injectable()
export class BookingDetectionService {
  private readonly logger = new Logger(BookingDetectionService.name);

  constructor(
    private readonly feishuBookingService: FeishuBookingService,
    private readonly bookingService: BookingService,
  ) {}

  /** 处理预约结果后的逻辑。 */
  async handleBookingSuccessAsync(params: {
    chatId: string;
    contactName: string;
    userId?: string;
    managerId?: string;
    managerName?: string;
    toolCalls?: AgentInvokeResult['toolCalls'];
  }): Promise<void> {
    const { chatId, contactName, userId, managerId, managerName, toolCalls } = params;

    const bookingToolCall = this.findLatestBookingToolCall(toolCalls);
    if (!bookingToolCall) return;

    const toolResult = this.toRecord(bookingToolCall.result);
    if (toolResult?.success !== true && toolResult?.success !== false) return;

    const bookingInfoFromTool = this.extractBookingInfoFromToolCall(bookingToolCall);
    const bookingInfo: InterviewBookingInfo = {
      ...bookingInfoFromTool,
      candidateName: bookingInfoFromTool.candidateName || contactName,
      chatId,
      userId,
      userName: contactName,
      managerId,
      managerName,
    };

    if (toolResult.success === true) {
      this.logger.log(`[${contactName}] 检测到预约成功工具结果，开始异步处理`);
      this.sendFeishuNotificationAsync(bookingInfo);
      this.updateBookingStatsAsync(bookingInfo);
      return;
    }

    this.logger.warn(
      `[${contactName}] 面试报名失败，开始发送飞书通知: ${this.extractFailureReason(toolResult)}`,
    );
    this.sendFeishuNotificationAsync(bookingInfo);
  }

  private findLatestBookingToolCall(
    toolCalls?: AgentInvokeResult['toolCalls'],
  ): BookingToolCall | null {
    if (!toolCalls?.length) return null;

    for (let i = toolCalls.length - 1; i >= 0; i -= 1) {
      const toolCall = toolCalls[i];
      if (toolCall.toolName === 'duliday_interview_booking') {
        return toolCall;
      }
    }

    return null;
  }

  private extractBookingInfoFromToolCall(toolCall: BookingToolCall): InterviewBookingInfo {
    const args = this.toRecord(toolCall.args) ?? {};
    const result = this.toRecord(toolCall.result) ?? {};
    const requestInfo = this.toRecord(result.requestInfo);

    return {
      candidateName: this.pickString(args.name, requestInfo?.name),
      interviewTime: this.pickString(args.interviewTime, requestInfo?.interviewTime),
      contactInfo: this.pickString(args.phone, requestInfo?.phone),
      toolOutput: result,
    };
  }

  private extractFailureReason(result: Record<string, unknown>): string {
    const errorList = Array.isArray(result.errorList)
      ? result.errorList
          .map((item) => {
            if (typeof item === 'string') return item.trim();
            try {
              return JSON.stringify(item);
            } catch {
              return String(item);
            }
          })
          .filter(Boolean)
          .join('；')
      : undefined;

    return this.pickString(result.error, result.message, result.notice, errorList) || '未知原因';
  }

  private toRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }

  private pickString(...values: unknown[]): string | undefined {
    for (const value of values) {
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
    return undefined;
  }

  private sendFeishuNotificationAsync(bookingInfo: InterviewBookingInfo): void {
    setImmediate(async () => {
      try {
        await this.feishuBookingService.sendBookingNotification(bookingInfo);
      } catch (error) {
        this.logger.error(`飞书预约通知发送失败: ${error.message}`);
      }
    });
  }

  private updateBookingStatsAsync(bookingInfo: InterviewBookingInfo): void {
    setImmediate(async () => {
      try {
        await this.bookingService.incrementBookingCount({
          brandName: bookingInfo.brandName,
          storeName: bookingInfo.storeName,
          chatId: bookingInfo.chatId,
          userId: bookingInfo.userId,
          userName: bookingInfo.userName,
          managerId: bookingInfo.managerId,
          managerName: bookingInfo.managerName,
        });
      } catch (error) {
        this.logger.error(`预约统计更新失败: ${error.message}`);
      }
    });
  }
}
