import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessageSenderService } from '../../message-sender/message-sender.service';
import { SendMessageType } from '../../message-sender/dto/send-message.dto';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MessageSplitter } from '../utils/message-splitter.util';
import { detectOutputLeak } from '../utils/output-leak-guard.util';
import { findCollapsedSameBrand } from '../utils/same-brand-collapse-guard.util';
import { DeliveryContext, DeliveryResult, AgentReply, DeliveryFailureError } from '../types';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { TypingPolicyService } from './typing-policy.service';

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
export class MessageDeliveryService implements OnModuleInit {
  private readonly logger = new Logger(MessageDeliveryService.name);

  constructor(
    private readonly messageSenderService: MessageSenderService,
    private readonly monitoringService: MessageTrackingService,
    private readonly typingPolicy: TypingPolicyService,
    private readonly wecomObservability: WecomMessageObservabilityService,
  ) {}

  async onModuleInit() {
    const typingConfig = this.typingPolicy.getSnapshot();
    this.logger.log(
      `消息发送运行时配置已就绪: splitSend=${typingConfig.splitSend}, typingSpeed=${typingConfig.typingSpeedCharsPerSec}字符/秒, paragraphGap=${typingConfig.paragraphGapMs}ms`,
    );
  }

  /**
   * 发送回复消息给用户
   * 统一处理直发和聚合两种场景
   */
  async deliverReply(
    reply: AgentReply,
    context: DeliveryContext,
    recordMonitoring: boolean = true,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const { messageId, contactName } = context;

    try {
      if (recordMonitoring) {
        this.monitoringService.recordSendStart(messageId);
        await this.wecomObservability.markDeliveryStart(messageId);
      }

      // 投递前兜底过滤：badcase vllg7hlu（输出泄漏）/ laybqxn4（同品牌多门店压缩）。
      // Prompt 软约束已存在但偶尔失守，这里做最后一道过滤——命中即静默丢弃整条回复，
      // 不重试不告警。被丢弃的回复仍计成功，避免触发上层重试再次外抛。
      const skipReason = this.findSkipReason(reply.content, contactName);
      if (skipReason) {
        const totalTime = Date.now() - startTime;
        const skippedResult: DeliveryResult = {
          success: true,
          segmentCount: 0,
          failedSegments: 0,
          deliveredSegments: 0,
          totalTime,
          skipped: true,
          skipReason,
        };
        if (recordMonitoring) {
          this.monitoringService.recordReplySkipped(messageId, skipReason);
          this.monitoringService.recordSendEnd(messageId);
          await this.wecomObservability.markDeliveryEnd(messageId, skippedResult);
        }
        return skippedResult;
      }

      const needsSplit = this.typingPolicy.shouldSplit(reply.content);
      const result = needsSplit
        ? await this.deliverSegments(reply.content, context)
        : await this.deliverSingle(reply.content, context);

      const totalTime = Date.now() - startTime;

      if (recordMonitoring) {
        this.monitoringService.recordSendEnd(messageId);
        await this.wecomObservability.markDeliveryEnd(messageId, { ...result, totalTime });
      }
      this.logger.log(
        `[${contactName}] 消息发送完成，耗时 ${totalTime}ms，发送 ${result.segmentCount} 个片段`,
      );

      return { ...result, totalTime };
    } catch (error) {
      const totalTime = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureResult =
        error instanceof DeliveryFailureError
          ? { ...error.result, totalTime }
          : {
              success: false,
              segmentCount: 0,
              failedSegments: 1,
              deliveredSegments: 0,
              totalTime,
              error: errorMessage,
            };

      if (recordMonitoring) {
        this.monitoringService.recordSendEnd(messageId);
        await this.wecomObservability.markDeliveryEnd(messageId, failureResult);
      }

      this.logger.error(`[${contactName}] 消息发送失败: ${errorMessage}`);
      throw new DeliveryFailureError(errorMessage, failureResult);
    }
  }

  private async deliverSingle(content: string, context: DeliveryContext): Promise<DeliveryResult> {
    const { token, imBotId, imContactId, imRoomId, contactName, chatId, _apiType } = context;

    try {
      await this.messageSenderService.sendMessage({
        token,
        imBotId,
        imContactId,
        imRoomId,
        chatId,
        messageType: SendMessageType.TEXT,
        payload: { text: content },
        _apiType,
      });
      await this.wecomObservability.markFirstSegmentSent(context.messageId);

      this.logger.log(`[${contactName}] 单条消息发送成功: "${this.truncate(content)}"`);
      return {
        success: true,
        segmentCount: 1,
        failedSegments: 0,
        deliveredSegments: 1,
        totalTime: 0,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[${contactName}] 单条消息发送失败: ${errorMessage}`);
      throw error;
    }
  }

  private async deliverSegments(
    content: string,
    context: DeliveryContext,
  ): Promise<DeliveryResult> {
    const { token, imBotId, imContactId, imRoomId, contactName, chatId, _apiType } = context;
    // 单次回复段数上限：防御性兜底，避免 Agent 写得过碎一次发 N 条消息刷屏。
    // 业务正常回复 1~4 段，超过 8 段一律视为异常并贪心合并最短相邻段。
    const MAX_SEGMENTS_PER_REPLY = 8;
    const segments = MessageSplitter.split(content, MAX_SEGMENTS_PER_REPLY);

    this.logger.log(
      `[${contactName}] 消息包含双换行符或"～"，拆分为 ${segments.length} 条消息发送`,
    );
    this.logger.debug(`[${contactName}] 原始消息: "${content}"`);
    this.logger.debug(`[${contactName}] 拆分结果: ${JSON.stringify(segments)}`);

    let successCount = 0;
    let failedCount = 0;
    let firstSegmentSent = false;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isFirstSegment = i === 0;

      const delayMs = this.calculateDelay(segment, isFirstSegment);
      this.logger.debug(
        `[${contactName}] 等待 ${delayMs}ms 后发送第 ${i + 1}/${segments.length} 条消息`,
      );
      await this.sleep(delayMs);

      this.logger.log(
        `[${contactName}] 发送第 ${i + 1}/${segments.length} 条消息: "${this.truncate(segment)}"`,
      );

      try {
        await this.messageSenderService.sendMessage({
          token,
          imBotId,
          imContactId,
          imRoomId,
          chatId,
          messageType: SendMessageType.TEXT,
          payload: { text: segment },
          _apiType,
        });
        successCount++;
        if (!firstSegmentSent) {
          firstSegmentSent = true;
          await this.wecomObservability.markFirstSegmentSent(context.messageId);
        }
      } catch (error) {
        failedCount++;
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `[${contactName}] 第 ${i + 1}/${segments.length} 条消息发送失败: ${errorMessage}`,
        );
      }
    }

    this.logger.log(
      `[${contactName}] 分段发送完成，成功 ${successCount}/${segments.length}，失败 ${failedCount}`,
    );

    const result: DeliveryResult = {
      success: failedCount === 0,
      segmentCount: segments.length,
      failedSegments: failedCount,
      deliveredSegments: successCount,
      totalTime: 0,
      error: failedCount > 0 ? `${failedCount}/${segments.length} 个消息片段发送失败` : undefined,
    };

    if (failedCount > 0) {
      throw new DeliveryFailureError(result.error!, result);
    }

    return result;
  }

  private calculateDelay(text: string, isFirstSegment: boolean = false): number {
    return this.typingPolicy.calculateDelay(text, isFirstSegment);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private truncate(text: string, maxLength: number = 50): string {
    return text.length <= maxLength ? text : `${text.substring(0, maxLength)}...`;
  }

  /**
   * 投递前回复内容兜底检查。命中任一规则即静默丢弃整条回复（不重试不告警）。
   * - output_leak：模型暴露内部阶段术语 / 工具调用 / JSON / 代码块（badcase vllg7hlu）
   * - same_brand_collapse：同品牌多门店被压缩成"X、X"（badcase laybqxn4）
   */
  private findSkipReason(
    content: string,
    contactName: string,
  ): DeliveryResult['skipReason'] | null {
    const leakedPattern = detectOutputLeak(content);
    if (leakedPattern) {
      this.logger.warn(
        `[${contactName}] 检测到内部状态泄漏，丢弃回复 (pattern=${leakedPattern.source}): "${this.truncate(content)}"`,
      );
      return 'output_leak';
    }

    const collapsedBrand = findCollapsedSameBrand(content);
    if (collapsedBrand) {
      this.logger.warn(
        `[${contactName}] 检测到同品牌多门店被压缩 (brand="${collapsedBrand}")，丢弃回复: "${this.truncate(content)}"`,
      );
      return 'same_brand_collapse';
    }

    return null;
  }
}
