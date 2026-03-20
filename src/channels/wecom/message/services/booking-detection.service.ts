import { Injectable, Logger } from '@nestjs/common';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';
import { BookingService } from '@biz/message/services/booking.service';
import { InterviewBookingInfo } from '@infra/feishu/interfaces/interface';

/**
 * 预约成功检测结果
 */
export interface BookingDetectionResult {
  detected: boolean;
  bookingInfo?: InterviewBookingInfo;
}

/**
 * 预约成功检测服务 (Business Logic)
 *
 * 职责：
 * 1. 从 Agent 响应文本中检测预约成功关键词
 * 2. 异步发送飞书通知
 * 3. 更新统计数据表
 */
@Injectable()
export class BookingDetectionService {
  private readonly logger = new Logger(BookingDetectionService.name);

  constructor(
    private readonly feishuBookingService: FeishuBookingService,
    private readonly bookingService: BookingService,
  ) {}

  /**
   * 从 Agent 响应文本中检测预约成功
   */
  detectBookingSuccess(replyText: string | undefined): BookingDetectionResult {
    if (!replyText) {
      return { detected: false };
    }

    if (this.isBookingSuccessful(replyText)) {
      this.logger.log('检测到预约成功关键词');
      return {
        detected: true,
        bookingInfo: this.extractBookingInfoFromText(replyText),
      };
    }

    return { detected: false };
  }

  private isBookingSuccessful(text: string): boolean {
    const successKeywords = ['预约成功', '面试预约已创建', 'booking_id'];
    const failureKeywords = ['预约失败', '失败', 'error', '错误'];
    const lowerText = text.toLowerCase();

    for (const keyword of failureKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) return false;
    }
    for (const keyword of successKeywords) {
      if (lowerText.includes(keyword.toLowerCase())) return true;
    }
    return false;
  }

  private extractBookingInfoFromText(text: string): InterviewBookingInfo {
    // 从回复文本中尝试提取预约信息（基础实现）
    return {
      toolOutput: { rawText: text.substring(0, 500) },
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
    replyText?: string;
  }): Promise<void> {
    const { chatId, contactName, userId, managerId, managerName, replyText } = params;
    const detection = this.detectBookingSuccess(replyText);

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
