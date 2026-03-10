import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MonitoringService } from '@/core/monitoring/monitoring.service';
import { SystemConfigService } from '@db/config';

// 导入子服务
import { MessageHistoryService } from './services/message-history.service';
import { SimpleMergeService } from './services/simple-merge.service';
import { MessageStatisticsService } from './services/message-statistics.service';
import { MessagePipelineService } from './services/message-pipeline.service';

// 导入工具和类型
import { MessageParser } from './utils/message-parser.util';
import { LogSanitizer } from './utils/log-sanitizer.util';
import {
  EnterpriseMessageCallbackDto,
  getMessageSourceDescription,
} from './dto/message-callback.dto';

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
    private readonly historyService: MessageHistoryService,
    private readonly simpleMergeService: SimpleMergeService,
    private readonly statisticsService: MessageStatisticsService,
    private readonly pipelineService: MessagePipelineService,
    // 监控
    private readonly monitoringService: MonitoringService,
    // Repository
    private readonly systemConfigService: SystemConfigService,
  ) {
    this.enableAiReply = this.configService.get<string>('ENABLE_AI_REPLY', 'true') === 'true';
    this.enableMessageMerge =
      this.configService.get<string>('ENABLE_MESSAGE_MERGE', 'true') === 'true';

    this.logger.log(`消息聚合功能: ${this.enableMessageMerge ? '已启用' : '已禁用'}`);
  }

  /**
   * 模块初始化 - 从 Supabase 加载开关状态
   */
  async onModuleInit() {
    this.enableAiReply = await this.systemConfigService.getAiReplyEnabled();
    this.enableMessageMerge = await this.systemConfigService.getMessageMergeEnabled();
    this.logger.log(`AI 自动回复功能: ${this.enableAiReply ? '已启用' : '已禁用'} (来自 Supabase)`);
    this.logger.log(
      `消息聚合功能: ${this.enableMessageMerge ? '已启用' : '已禁用'} (来自 Supabase)`,
    );
  }

  /**
   * 处理接收到的消息（主入口）
   * 消息处理管线：开关检查 → 过滤 → 去重 → 监控 → 分派
   */
  async handleMessage(messageData: EnterpriseMessageCallbackDto) {
    // 【安全】仅在 debug 级别输出脱敏后的消息数据
    const sanitized = LogSanitizer.sanitizeMessageCallback(messageData);
    this.logger.debug('=== [回调消息数据(已脱敏)] ===');
    this.logger.debug(JSON.stringify(sanitized, null, 2));

    this.logger.log(
      `[handleMessage] 收到消息 [${messageData.messageId}], source=${messageData.source}(${getMessageSourceDescription(messageData.source)}), isSelf=${messageData.isSelf}`,
    );

    // 管线步骤 0: 处理 bot 自己发送的消息
    if (messageData.isSelf === true) {
      await this.pipelineService.handleSelfMessage(messageData);
      return { success: true, message: 'Self message stored' };
    }

    // 管线步骤 1: 消息过滤
    const filterResult = await this.pipelineService.filterMessage(messageData);
    if (!filterResult.continue) {
      return filterResult.response;
    }

    // 管线步骤 2: 消息去重
    const dedupeResult = await this.pipelineService.checkDuplicationAsync(messageData);
    if (!dedupeResult.continue) {
      return dedupeResult.response;
    }

    // 管线步骤 3: 记录历史
    await this.pipelineService.recordUserMessageToHistory(messageData, filterResult.data?.content);

    // 管线步骤 4: 记录监控
    this.pipelineService.recordMessageReceived(messageData);

    // 管线步骤 5: 全局开关关闭时，仅记录历史不触发 AI
    if (!this.enableAiReply) {
      const parsed = MessageParser.parse(messageData);
      this.logger.log(
        `[AI回复已禁用] 消息已记录到历史 [${messageData.messageId}]` +
          (parsed.chatId ? `, chatId=${parsed.chatId}` : ''),
      );
      this.monitoringService.recordSuccess(messageData.messageId, {
        scenario: MessageParser.determineScenario(messageData),
        replyPreview: '[AI回复已禁用]',
      });
      return { success: true, message: 'AI reply disabled, message recorded to history' };
    }

    // 管线步骤 6: 分派处理
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

  // ========================================
  // 状态管理 API
  // ========================================

  /**
   * 获取 AI 回复开关状态
   */
  getAiReplyStatus(): boolean {
    return this.enableAiReply;
  }

  /**
   * 切换 AI 回复开关（持久化到 Supabase）
   */
  async toggleAiReply(enabled: boolean): Promise<boolean> {
    this.enableAiReply = enabled;
    await this.systemConfigService.setAiReplyEnabled(enabled);
    this.logger.log(`AI 自动回复功能已${enabled ? '启用' : '禁用'} (已持久化到 Supabase)`);
    return this.enableAiReply;
  }

  /**
   * 获取消息聚合开关状态
   */
  getMessageMergeStatus(): boolean {
    return this.enableMessageMerge;
  }

  /**
   * 切换消息聚合开关（持久化到 Supabase）
   */
  async toggleMessageMerge(enabled: boolean): Promise<boolean> {
    this.enableMessageMerge = enabled;
    await this.systemConfigService.setMessageMergeEnabled(enabled);
    this.logger.log(`消息聚合功能已${enabled ? '启用' : '禁用'} (已持久化到 Supabase)`);
    return this.enableMessageMerge;
  }

  // ========================================
  // 统计和缓存 API
  // ========================================

  /**
   * 获取服务状态
   */
  getServiceStatus() {
    return this.statisticsService.getServiceStatus(
      this.processingCount,
      0,
      this.enableAiReply,
      this.enableMessageMerge,
      true,
    );
  }

  /**
   * 获取缓存统计
   */
  getCacheStats() {
    return this.statisticsService.getCacheStats(this.processingCount, 0);
  }

  /**
   * 获取历史记录
   */
  async getAllHistory(chatId?: string) {
    if (chatId) {
      const detail = await this.historyService.getHistoryDetail(chatId);
      if (detail) {
        return {
          chatId,
          messages: detail.messages,
          count: detail.messageCount,
        };
      }
      return {
        chatId,
        messages: [],
        count: 0,
      };
    }

    return this.historyService.getStats();
  }

  /**
   * 清理缓存
   */
  clearCache(options?: {
    deduplication?: boolean;
    history?: boolean;
    mergeQueues?: boolean;
    chatId?: string;
  }) {
    return this.statisticsService.clearCache(options);
  }
}
