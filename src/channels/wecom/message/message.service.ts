import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';

// 导入子服务
import { SimpleMergeService } from './runtime/simple-merge.service';
import { MessageDeduplicationService } from './runtime/deduplication.service';
import { MessagePipelineService } from './application/pipeline.service';
import { WecomMessageObservabilityService } from './telemetry/wecom-message-observability.service';
import { MessageRuntimeConfigService } from './runtime/message-runtime-config.service';

// 导入工具和类型
import { MessageParser } from './utils/message-parser.util';
import { LogSanitizer } from './utils/log-sanitizer.util';
import { EnterpriseMessageCallbackDto } from './ingress/message-callback.dto';
import { getMessageSourceDescription } from '@enums/message-callback.enum';

/**
 * 消息处理服务（重构版 v4 - 协调器模式）
 *
 * 职责：
 * 1. 消息入口和分派
 * 2. 基于运行时配置决定分派策略
 * 3. 统计和缓存 API
 *
 * 处理逻辑委托给 MessagePipelineService
 * 从 743 行精简到 ~280 行
 */
@Injectable()
export class MessageService implements OnModuleInit {
  private readonly logger = new Logger(MessageService.name);

  // 监控统计：跟踪正在处理的消息数
  private processingCount: number = 0;

  constructor(
    // 子服务
    private readonly simpleMergeService: SimpleMergeService,
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly pipelineService: MessagePipelineService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    // 监控
    private readonly monitoringService: MessageTrackingService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
  ) {}

  /**
   * 模块初始化 - 记录当前运行时配置快照
   */
  async onModuleInit() {
    this.logger.log(
      `AI 自动回复功能: ${this.runtimeConfig.isAiReplyEnabled() ? '已启用' : '已禁用'} (来自运行时配置)`,
    );
    this.logger.log(
      `消息聚合功能: ${this.runtimeConfig.isMessageMergeEnabled() ? '已启用' : '已禁用'} (来自运行时配置)`,
    );
  }

  /**
   * 处理接收到的消息（主入口）
   *
   * 立即 ACK 语义：托管平台若 callback 未尽快返回 200，会按"超时"规则补发同内容消息
   * （此前出现过同一"六姐"被补发 3 次的流水）。为避免补发，本方法只做同步打点，
   * 随后把 runtimeConfig.syncSnapshot → pipeline 过滤 → 分派 全部放到微任务队列里执行，
   * HTTP 响应永远在 ms 级返回。
   */
  handleMessage(messageData: EnterpriseMessageCallbackDto) {
    messageData._receivedAtMs = messageData._receivedAtMs ?? Date.now();

    void this.processMessageAsync(messageData).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[异步消息处理] messageId=${messageData.messageId} 失败: ${errorMessage}`);
    });

    return { success: true, message: 'Message received' };
  }

  /**
   * 异步消息处理主体
   *
   * 所有会命中 Supabase / Redis / 外部依赖的逻辑都在这里。任何抛错都被
   * handleMessage 的 .catch 兜底，不会影响已经返回给托管平台的 200。
   */
  private async processMessageAsync(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    await this.runtimeConfig.syncSnapshot();

    const sanitized = LogSanitizer.sanitizeMessageCallback(messageData);
    this.logger.debug('=== [回调消息数据(已脱敏)] ===');
    this.logger.debug(JSON.stringify(sanitized, null, 2));

    this.logger.log(
      `[handleMessage] 收到消息 [${messageData.messageId}], source=${messageData.source}(${getMessageSourceDescription(messageData.source)}), isSelf=${messageData.isSelf}`,
    );

    // 步骤 0-4: 过滤 → 去重 → 写历史 → 监控
    const pipelineResult = await this.pipelineService.execute(messageData);

    if (!pipelineResult.shouldDispatch) {
      return;
    }

    // 步骤 5: 全局 AI 开关
    if (!this.runtimeConfig.isAiReplyEnabled()) {
      const parsed = MessageParser.parse(messageData);
      await this.ensureRequestTrace(messageData, pipelineResult.content ?? parsed.content);
      await this.wecomObservability.updateDispatch(messageData.messageId, 'disabled');
      const successMetadata = await this.wecomObservability.buildSuccessMetadata(
        messageData.messageId,
        {
          scenario: MessageParser.determineScenario(),
          replyPreview: '[AI回复已禁用]',
          replySegments: 0,
          extraResponse: { disabledAiReply: true },
        },
      );
      this.logger.log(
        `[AI回复已禁用] 消息已记录到历史 [${messageData.messageId}]` +
          (parsed.chatId ? `, chatId=${parsed.chatId}` : ''),
      );
      this.monitoringService.recordSuccess(messageData.messageId, successMetadata);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      return;
    }

    // 步骤 6: 分派（聚合 or 直发）
    await this.dispatchMessage(messageData).catch((error) => {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`[分派异常] 消息 [${messageData.messageId}] 分派失败: ${errorMessage}`);
    });
  }

  /**
   * 分派消息（聚合 or 直接处理）
   */
  private async dispatchMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    if (this.runtimeConfig.isMessageMergeEnabled()) {
      try {
        await this.simpleMergeService.addMessage(messageData);
      } catch (error) {
        const parsed = MessageParser.parse(messageData);
        const errorMessage = error instanceof Error ? error.message : String(error);

        this.logger.error(`[聚合调度] 处理消息 [${messageData.messageId}] 失败: ${errorMessage}`);
        await this.ensureRequestTrace(messageData, parsed.content);
        await this.wecomObservability.updateDispatch(messageData.messageId, 'merged');
        const failureMetadata = await this.wecomObservability.buildFailureMetadata(
          messageData.messageId,
          {
            scenario: MessageParser.determineScenario(),
            errorType: 'merge',
            errorMessage,
            extraResponse: {
              phase: 'enqueue',
              chatId: parsed.chatId,
            },
          },
        );
        this.monitoringService.recordFailure(messageData.messageId, errorMessage, failureMetadata);
        await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      }
      return;
    }

    // 未启用聚合：直接处理
    this.processingCount++;
    this.pipelineService
      .processSingleMessage(messageData)
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.error(`异步处理消息失败 [${messageData.messageId}]:`, errorMessage);
      })
      .finally(() => {
        this.processingCount--;
      });
  }

  /**
   * 处理聚合后的消息（供 MessageProcessor 调用）
   */
  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    this.processingCount++;
    try {
      await this.pipelineService.processMergedMessages(messages, batchId);
    } finally {
      this.processingCount--;
    }
  }

  /**
   * 处理发送结果回调
   */
  async handleSentResult(resultData: unknown) {
    const requestId = (resultData as { requestId?: string })?.requestId;
    this.logger.debug(`收到发送结果回调: ${requestId || 'N/A'}`);
    return { success: true };
  }

  /**
   * 清理缓存
   */
  async clearCache(options?: {
    deduplication?: boolean;
    history?: boolean;
    mergeQueues?: boolean;
    chatId?: string;
  }) {
    const opts = options || { deduplication: true, history: true, mergeQueues: true };
    const cleared = { deduplication: false, history: false, mergeQueues: false };

    if (opts.deduplication) {
      await this.deduplicationService.clearAll();
      cleared.deduplication = true;
    }
    if (opts.history) cleared.history = true; // 历史由 Supabase 永久存储，无需手动清理
    if (opts.mergeQueues) cleared.mergeQueues = true; // Redis TTL 自动处理

    return { timestamp: new Date().toISOString(), cleared };
  }

  private async ensureRequestTrace(
    messageData: EnterpriseMessageCallbackDto,
    content: string,
    batchId?: string,
  ): Promise<void> {
    if (await this.wecomObservability.hasTrace(messageData.messageId)) {
      return;
    }

    await this.wecomObservability.startRequestTrace({
      traceId: messageData.messageId,
      primaryMessage: messageData,
      scenario: MessageParser.determineScenario(),
      content,
      batchId,
    });
  }
}
