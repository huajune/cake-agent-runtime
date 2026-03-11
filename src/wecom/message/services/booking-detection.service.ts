import { Injectable, Logger } from '@nestjs/common';
import { FeishuBookingService } from '@core/feishu';
import { BookingRepository } from '@biz/message/repositories';
import { ChatResponse, UIMessage } from '@agent';
import { InterviewBookingInfo } from '@core/feishu/interfaces/feishu.interface';

/**
 * 工具调用结果 Part 类型
 */
interface ToolResultPart {
  type: 'tool-invocation';
  toolName: string;
  input?: Record<string, unknown>;
  output?: {
    text?: string;
    [key: string]: unknown;
  };
}

/**
 * 预约成功检测结果
 */
export interface BookingDetectionResult {
  detected: boolean;
  bookingInfo?: InterviewBookingInfo;
  toolOutput?: Record<string, unknown>;
}

/**
 * 预约成功检测服务 (Business Logic)
 *
 * 职责：
 * 1. 从 Agent 响应中检测预约成功的工具调用
 * 2. 异步发送飞书通知
 * 3. 更新统计数据表
 */
@Injectable()
export class BookingDetectionService {
  private readonly logger = new Logger(BookingDetectionService.name);

  // 预约相关的工具名称
  private readonly BOOKING_TOOL_NAME = 'duliday_book_interview';

  constructor(
    private readonly feishuBookingService: FeishuBookingService,
    private readonly bookingRepository: BookingRepository,
  ) {}

  /**
   * 检测 Agent 响应中是否有预约成功
   */
  detectBookingSuccess(chatResponse: ChatResponse | undefined): BookingDetectionResult {
    if (!chatResponse?.messages) {
      return { detected: false };
    }

    for (const message of chatResponse.messages) {
      if (message.role !== 'assistant') continue;
      const result = this.checkMessageForBooking(message);
      if (result.detected) return result;
    }

    return { detected: false };
  }

  private checkMessageForBooking(message: UIMessage): BookingDetectionResult {
    if (!message.parts) return { detected: false };

    for (const part of message.parts as unknown[]) {
      const toolPart = part as ToolResultPart;
      if (toolPart.type !== 'tool-invocation') continue;
      if (toolPart.toolName !== this.BOOKING_TOOL_NAME) continue;

      const output = toolPart.output;
      if (!output) continue;

      const outputText = output.text || '';
      const isSuccess = this.isBookingSuccessful(outputText);

      if (isSuccess) {
        this.logger.log(`检测到预约成功工具调用: ${this.BOOKING_TOOL_NAME}`);
        const parsedOutput = this.parseToolOutput(outputText);
        return {
          detected: true,
          bookingInfo: this.extractBookingInfo(toolPart.input, parsedOutput),
          toolOutput: parsedOutput,
        };
      }
    }

    return { detected: false };
  }

  private isBookingSuccessful(outputText: string): boolean {
    const successKeywords = ['预约成功', '面试预约已创建', 'booking_id'];
    const failureKeywords = ['预约失败', '失败', 'error', '错误'];
    const lowerText = outputText.toLowerCase();

    for (const keyword of failureKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) return false;
    }
    for (const keyword of successKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) return true;
    }
    return false;
  }

  private parseToolOutput(outputText: string): Record<string, unknown> {
    try {
      return JSON.parse(outputText);
    } catch {
      return { message: outputText };
    }
  }

  private extractBookingInfo(
    input?: Record<string, unknown>,
    output?: Record<string, unknown>,
  ): InterviewBookingInfo {
    return {
      candidateName: (input?.candidateName as string) || undefined,
      brandName: (input?.brandName as string) || undefined,
      storeName: (input?.storeName as string) || undefined,
      interviewTime: (input?.interviewTime as string) || undefined,
      contactInfo: (input?.contactInfo as string) || undefined,
      toolOutput: output,
    };
  }

  /**
   * 处理预约成功后的逻辑
   */
  async handleBookingSuccessAsync(params: {
    chatId: string;
    contactName: string;
    userId?: string;
    managerId?: string;
    managerName?: string;
    chatResponse: ChatResponse | undefined;
  }): Promise<void> {
    const { chatId, contactName, userId, managerId, managerName, chatResponse } = params;
    const detection = this.detectBookingSuccess(chatResponse);

    if (!detection.detected || !detection.bookingInfo) return;

    this.logger.log(`[${contactName}] 检测到预约成功，开始异步处理`);

    const bookingInfo: InterviewBookingInfo = {
      ...detection.bookingInfo,
      candidateName: detection.bookingInfo.candidateName || contactName,
      chatId,
      userId,
      userName: contactName,
      managerId,
      managerName,
    };

    this.sendFeishuNotificationAsync(bookingInfo);
    this.updateBookingStatsAsync(bookingInfo);
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
        await this.bookingRepository.incrementBookingCount({
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
