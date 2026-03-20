import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';

// 导入子服务
import { SimpleMergeService } from './services/simple-merge.service';
import { MessageDeduplicationService } from './services/deduplication.service';
import { MessagePipelineService } from './services/pipeline.service';

// 导入工具和类型
import { MessageParser } from './utils/message-parser.util';
import { LogSanitizer } from './utils/log-sanitizer.util';
import { EnterpriseMessageCallbackDto } from './message-callback.dto';
import { getMessageSourceDescription } from '@enums/message-callback.enum';

/**
 * 消息处理服务（重构版 v4 - 协调器模式）
 *
 * 职责：
 * 1. 消息入口和分派
 * 2. 开关状态管理（AI 回复、消息聚合）
 * 3. 统计和缓存 API
 *
 * 处理逻辑委托给 MessagePipelineService
 * 从 743 行精简到 ~280 行
 */
@Injectable()
export class MessageService implements OnModuleInit {
  private readonly logger = new Logger(MessageService.name);
  private enableAiReply: boolean;
  private enableMessageMerge: boolean;

  // 监控统计：跟踪正在处理的消息数
  private processingCount: number = 0;

  constructor(
    private readonly configService: ConfigService,
    // 子服务
    private readonly simpleMergeService: SimpleMergeService,
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly pipelineService: MessagePipelineService,
    // 监控
    private readonly monitoringService: MessageTrackingService,
    // Repository
    private readonly systemConfigService: SystemConfigService,
  ) {
    this.enableAiReply = this.configService.get<string>('ENABLE_AI_REPLY', 'true') === 'true';
    this.enableMessageMerge =
      this.configService.get<string>('ENABLE_MESSAGE_MERGE', 'true') === 'true';

    this.logger.log(`消息聚合功能: ${this.enableMessageMerge ? '已启用' : '已禁用'}`);
  }

  /**
   * 模块初始化 - 从 Supabase 加载开关状态，并订阅变更
   */
  async onModuleInit() {
    this.enableAiReply = await this.systemConfigService.getAiReplyEnabled();
    this.enableMessageMerge = await this.systemConfigService.getMessageMergeEnabled();
    this.logger.log(`AI 自动回复功能: ${this.enableAiReply ? '已启用' : '已禁用'} (来自 Supabase)`);
    this.logger.log(
      `消息聚合功能: ${this.enableMessageMerge ? '已启用' : '已禁用'} (来自 Supabase)`,
    );

    // 订阅开关变更，确保 hosting-config 层的切换能实时生效
    this.systemConfigService.onAiReplyChange((enabled) => {
      this.enableAiReply = enabled;
      this.logger.log(`AI 自动回复功能已${enabled ? '启用' : '禁用'} (来自配置变更)`);
    });
    this.systemConfigService.onMessageMergeChange((enabled) => {
      this.enableMessageMerge = enabled;
      this.logger.log(`消息聚合功能已${enabled ? '启用' : '禁用'} (来自配置变更)`);
    });
  }

  /**
   * 处理接收到的消息（主入口）
   * 步骤 0-4 由 pipeline.execute() 统一执行
   * 步骤 5（AI 开关）和步骤 6（分派）由本服务控制
   */
  async handleMessage(messageData: EnterpriseMessageCallbackDto) {
    const sanitized = LogSanitizer.sanitizeMessageCallback(messageData);
    this.logger.debug('=== [回调消息数据(已脱敏)] ===');
    this.logger.debug(JSON.stringify(sanitized, null, 2));

    this.logger.log(
      `[handleMessage] 收到消息 [${messageData.messageId}], source=${messageData.source}(${getMessageSourceDescription(messageData.source)}), isSelf=${messageData.isSelf}`,
    );

    // 步骤 0-4: 过滤 → 去重 → 写历史 → 监控
    const pipelineResult = await this.pipelineService.execute(messageData);

    if (!pipelineResult.shouldDispatch) {
      return pipelineResult.response;
    }

    // 步骤 5: 全局 AI 开关
    if (!this.enableAiReply) {
      const parsed = MessageParser.parse(messageData);
      this.logger.log(
        `[AI回复已禁用] 消息已记录到历史 [${messageData.messageId}]` +
          (parsed.chatId ? `, chatId=${parsed.chatId}` : ''),
      );
      this.monitoringService.recordSuccess(messageData.messageId, {
        scenario: MessageParser.determineScenario(),
        replyPreview: '[AI回复已禁用]',
      });
      return { success: true, message: 'AI reply disabled, message recorded to history' };
    }

    // 步骤 6: 分派（聚合 or 直发）
    this.dispatchMessage(messageData).catch((error) => {
      this.logger.error(`[分派异常] 消息 [${messageData.messageId}] 分派失败: ${error.message}`);
    });

    return { success: true, message: 'Message received' };
  }

  /**
   * 分派消息（聚合 or 直接处理）
   */
  private async dispatchMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    if (this.enableMessageMerge) {
      this.simpleMergeService.addMessage(messageData).catch((error) => {
        this.logger.error(`[聚合调度] 处理消息 [${messageData.messageId}] 失败: ${error.message}`);
      });
      return;
    }

    // 未启用聚合：直接处理
    this.processingCount++;
    this.pipelineService
      .processSingleMessage(messageData)
      .catch((error) => {
        this.logger.error(`异步处理消息失败 [${messageData.messageId}]:`, error.message);
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
}
