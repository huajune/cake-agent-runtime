import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageSenderService } from '../../message-sender/message-sender.service';
import { SendMessageType } from '../../message-sender/dto/send-message.dto';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { TypingDelayService } from './typing-delay.service';
import { MessageSplitter } from '../utils/message-splitter.util';
import {
  DeliveryContext,
  DeliveryResult,
  MessageSegment,
  AgentReply,
} from '../types/wecom-message.types';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';

/**
 * 消息发送服务
 * 统一处理消息分段发送、模拟打字延迟、监控埋点
 *
 * 职责：
 * - 根据配置决定是否分段发送
 * - 为每个片段计算智能延迟
 * - 记录发送监控指标
 * - 处理发送失败重试
 */
@Injectable()
export class MessageDeliveryService {
  private readonly logger = new Logger(MessageDeliveryService.name);
  private readonly enableMessageSplitSend: boolean;

  constructor(
    private readonly messageSenderService: MessageSenderService,
    private readonly monitoringService: MessageTrackingService,
    private readonly typingDelayService: TypingDelayService,
    private readonly configService: ConfigService,
    private readonly feishuAlertService: FeishuAlertService,
  ) {
    this.enableMessageSplitSend =
      this.configService.get<string>('ENABLE_MESSAGE_SPLIT_SEND', 'true') === 'true';
  }

  /**
   * 发送回复消息给用户
   * 统一处理直发和聚合两种场景
   *
   * @param reply Agent 回复内容
   * @param context 发送上下文
   * @param recordMonitoring 是否记录监控（直发需要，聚合不需要重复记录）
   * @returns 发送结果
   */
  async deliverReply(
    reply: AgentReply,
    context: DeliveryContext,
    recordMonitoring: boolean = true,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const { messageId, contactName } = context;

    try {
      // 1. 【监控埋点】发送开始
      if (recordMonitoring) {
        this.monitoringService.recordSendStart(messageId);
      }

      // 2. 判断是否需要分段发送
      const needsSplit = this.enableMessageSplitSend && MessageSplitter.needsSplit(reply.content);

      let result: DeliveryResult;

      if (needsSplit) {
        // 分段发送
        result = await this.deliverSegments(reply.content, context);
      } else {
        // 单条发送
        result = await this.deliverSingle(reply.content, context);
      }

      // 3. 【监控埋点】发送完成
      if (recordMonitoring) {
        this.monitoringService.recordSendEnd(messageId);
      }

      const totalTime = Date.now() - startTime;
      this.logger.log(
        `[${contactName}] 消息发送完成，耗时 ${totalTime}ms，发送 ${result.segmentCount} 个片段`,
      );

      return {
        ...result,
        totalTime,
      };
    } catch (error) {
      const totalTime = Date.now() - startTime;
      this.logger.error(`[${contactName}] 消息发送失败: ${error.message}`);

      // 发送告警
      await this.sendDeliveryFailureAlert(error, context, reply.content);

      return {
        success: false,
        segmentCount: 0,
        failedSegments: 1,
        totalTime,
        error: error.message,
      };
    }
  }

  /**
   * 发送单条完整消息
   */
  private async deliverSingle(content: string, context: DeliveryContext): Promise<DeliveryResult> {
    const { token, imBotId, imContactId, imRoomId, contactName, chatId, _apiType } = context;

    try {
      await this.messageSenderService.sendMessage({
        token,
        // 企业级字段
        imBotId,
        imContactId,
        imRoomId,
        // 小组级字段
        chatId,
        // 通用字段
        messageType: SendMessageType.TEXT,
        payload: { text: content },
        _apiType, // 传递 API 类型标记
      });

      this.logger.log(`[${contactName}] 单条消息发送成功: "${this.truncate(content)}"`);

      return {
        success: true,
        segmentCount: 1,
        failedSegments: 0,
        totalTime: 0, // 将由 deliverReply 填充
      };
    } catch (error) {
      this.logger.error(`[${contactName}] 单条消息发送失败: ${error.message}`);
      throw error;
    }
  }

  /**
   * 分段发送消息
   */
  private async deliverSegments(
    content: string,
    context: DeliveryContext,
  ): Promise<DeliveryResult> {
    const { token, imBotId, imContactId, imRoomId, contactName, chatId, _apiType } = context;
    const segments = MessageSplitter.split(content);

    this.logger.log(
      `[${contactName}] 消息包含双换行符或"～"，拆分为 ${segments.length} 条消息发送`,
    );
    this.logger.debug(`[${contactName}] 原始消息: "${content}"`);
    this.logger.debug(`[${contactName}] 拆分结果: ${JSON.stringify(segments)}`);

    let successCount = 0;
    let failedCount = 0;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFirstSegment = i === 0;

      // 计算并执行延迟
      const delayMs = this.typingDelayService.calculateDelay(segment, isFirstSegment);
      this.logger.debug(
        `[${contactName}] 等待 ${delayMs}ms 后发送第 ${i + 1}/${segments.length} 条消息`,
      );
      await this.typingDelayService.delay(delayMs);

      this.logger.log(
        `[${contactName}] 发送第 ${i + 1}/${segments.length} 条消息: "${this.truncate(segment)}"`,
      );

      try {
        await this.messageSenderService.sendMessage({
          token,
          // 企业级字段
          imBotId,
          imContactId,
          imRoomId,
          // 小组级字段
          chatId,
          // 通用字段
          messageType: SendMessageType.TEXT,
          payload: { text: segment },
          _apiType, // 传递 API 类型标记
        });

        successCount++;
        this.logger.debug(`[${contactName}] 第 ${i + 1}/${segments.length} 条消息发送成功`);
      } catch (error) {
        failedCount++;
        this.logger.error(
          `[${contactName}] 第 ${i + 1}/${segments.length} 条消息发送失败: ${error.message}`,
        );
        // 发送失败时仍然继续发送后续消息
      }
    }

    this.logger.log(
      `[${contactName}] 分段发送完成，成功 ${successCount}/${segments.length}，失败 ${failedCount}`,
    );

    // 如果有失败片段，发送告警
    if (failedCount > 0) {
      const errorMsg = `${failedCount}/${segments.length} 个消息片段发送失败`;
      await this.sendDeliveryFailureAlert(new Error(errorMsg), context, content);
    }

    return {
      success: failedCount === 0,
      segmentCount: segments.length,
      failedSegments: failedCount,
      totalTime: 0, // 将由 deliverReply 填充
    };
  }

  /**
   * 发送消息发送失败告警
   */
  private async sendDeliveryFailureAlert(
    error: Error,
    context: DeliveryContext,
    content: string,
  ): Promise<void> {
    try {
      await this.feishuAlertService.sendAlert({
        errorType: 'delivery',
        error,
        conversationId: context.chatId,
        userMessage: content.substring(0, 100),
        apiEndpoint: '/message-sender/send',
      });
    } catch (alertError) {
      this.logger.error(`发送失败告警发送失败: ${alertError.message}`);
    }
  }

  /**
   * 创建消息片段数组
   */
  private createSegments(segments: string[]): MessageSegment[] {
    const total = segments.length;
    return segments.map((content, index) => ({
      content,
      index,
      total,
      isFirst: index === 0,
      isLast: index === total - 1,
    }));
  }

  /**
   * 截断长文本用于日志
   */
  private truncate(text: string, maxLength: number = 50): string {
    if (text.length <= maxLength) {
      return text;
    }
    return `${text.substring(0, maxLength)}...`;
  }
}
