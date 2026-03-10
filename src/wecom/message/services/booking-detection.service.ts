import { Injectable, Logger } from '@nestjs/common';
import { FeishuBookingService } from '@core/feishu';
import { BookingRepository } from '@supabase/message';
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
 * 预约成功检测服务
 *
 * 职责：
 * 1. 从 Agent 响应中检测预约成功的工具调用
 * 2. 异步发送飞书通知
 * 3. 更新统计数据表
 *
 * 设计原则：
 * - 事件驱动：在 Agent 响应返回后立即检测
 * - 异步处理：通知发送不阻塞主流程
 * - 单一职责：仅负责预约成功的检测和后续处理
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
   *
   * @param chatResponse Agent 原始响应
   * @returns 检测结果
   */
  detectBookingSuccess(chatResponse: ChatResponse | undefined): BookingDetectionResult {
    if (!chatResponse?.messages) {
      return { detected: false };
    }

    // 遍历所有消息，查找预约工具调用
    for (const message of chatResponse.messages) {
      if (message.role !== 'assistant') continue;

      const result = this.checkMessageForBooking(message);
      if (result.detected) {
        return result;
      }
    }

    return { detected: false };
  }

  /**
   * 检查单条消息中是否包含预约成功
   */
  private checkMessageForBooking(message: UIMessage): BookingDetectionResult {
    if (!message.parts) {
      return { detected: false };
    }

    for (const part of message.parts as unknown[]) {
      const toolPart = part as ToolResultPart;

      // 检查是否是工具调用
      if (toolPart.type !== 'tool-invocation') continue;

      // 检查是否是预约工具
      if (toolPart.toolName !== this.BOOKING_TOOL_NAME) continue;

      // 检查工具输出是否表示成功
      const output = toolPart.output;
      if (!output) continue;

      // 解析工具输出文本
      const outputText = output.text || '';
      const isSuccess = this.isBookingSuccessful(outputText);

      if (isSuccess) {
        this.logger.log(`检测到预约成功工具调用: ${this.BOOKING_TOOL_NAME}`);

        // 从工具输出中提取预约信息
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

  /**
   * 判断工具输出是否表示预约成功
   */
  private isBookingSuccessful(outputText: string): boolean {
    // 成功关键词
    const successKeywords = ['预约成功', '面试预约已创建', 'booking_id'];

    // 失败关键词
    const failureKeywords = ['预约失败', '失败', 'error', '错误'];

    const lowerText = outputText.toLowerCase();

    // 检查是否包含失败关键词
    for (const keyword of failureKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        return false;
      }
    }

    // 检查是否包含成功关键词
    for (const keyword of successKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) {
        return true;
      }
    }

    return false;
  }

  /**
   * 解析工具输出文本为对象
   */
  private parseToolOutput(outputText: string): Record<string, unknown> {
    try {
      // 尝试解析 JSON
      return JSON.parse(outputText);
    } catch {
      // 如果不是 JSON，返回原始文本
      return { message: outputText };
    }
  }

  /**
   * 从工具调用中提取预约信息
   */
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
   * - 发送飞书通知（异步）
   * - 更新统计数据（异步）
   *
   * @param params 预约处理参数
   */
  async handleBookingSuccessAsync(params: {
    chatId: string;
    contactName: string;
    userId?: string; // 用户的系统 wxid (imContactId)
    managerId?: string; // 招募经理 ID (botUserId/imBotId)
    managerName?: string; // 招募经理昵称
    chatResponse: ChatResponse | undefined;
  }): Promise<void> {
    const { chatId, contactName, userId, managerId, managerName, chatResponse } = params;

    const detection = this.detectBookingSuccess(chatResponse);

    if (!detection.detected || !detection.bookingInfo) {
      return;
    }

    this.logger.log(`[${contactName}] 检测到预约成功，开始异步处理`);

    // 补充候选人和招募经理信息
    const bookingInfo: InterviewBookingInfo = {
      ...detection.bookingInfo,
      candidateName: detection.bookingInfo.candidateName || contactName,
      chatId,
      userId,
      userName: contactName,
      managerId,
      managerName,
    };

    // 异步发送飞书通知（不阻塞主流程）
    this.sendFeishuNotificationAsync(bookingInfo);

    // 异步更新统计数据（不阻塞主流程）
    this.updateBookingStatsAsync(bookingInfo);
  }

  /**
   * 异步发送飞书通知
   */
  private sendFeishuNotificationAsync(bookingInfo: InterviewBookingInfo): void {
    // 使用 setImmediate 确保异步执行，不阻塞主流程
    setImmediate(async () => {
      try {
        const success = await this.feishuBookingService.sendBookingNotification(bookingInfo);
        if (success) {
          this.logger.log(
            `飞书预约通知已发送: ${bookingInfo.candidateName} - ${bookingInfo.brandName}`,
          );
        }
      } catch (error) {
        this.logger.error(`飞书预约通知发送失败: ${error.message}`);
      }
    });
  }

  /**
   * 异步更新预约统计数据
   */
  private updateBookingStatsAsync(bookingInfo: InterviewBookingInfo): void {
    // 使用 setImmediate 确保异步执行，不阻塞主流程
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
        this.logger.debug(`预约统计已更新: ${bookingInfo.brandName}`);
      } catch (error) {
        this.logger.error(`预约统计更新失败: ${error.message}`);
      }
    });
  }
}
