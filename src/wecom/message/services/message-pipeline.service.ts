import { Injectable, Logger } from '@nestjs/common';
import { MonitoringService } from '@/core/monitoring/monitoring.service';
import { FeishuAlertService, AlertLevel, ALERT_RECEIVERS } from '@core/feishu';
import { maskApiKey } from '@core/utils';
import { ScenarioType } from '@agent';
import {
  AgentException,
  AgentAuthException,
  AgentRateLimitException,
  AgentConfigException,
  AgentContextMissingException,
} from '@/agent/utils/agent-exceptions';

// 导入子服务
import { MessageDeduplicationService } from './message-deduplication.service';
import { MessageHistoryService } from './message-history.service';
import { MessageFilterService } from './message-filter.service';
import { MessageDeliveryService } from './message-delivery.service';
import { AgentGatewayService } from './message-agent-gateway.service';
import { BookingDetectionService } from './booking-detection.service';

// 导入工具和类型
import { MessageParser } from '../utils/message-parser.util';
import { EnterpriseMessageCallbackDto } from '../dto/message-callback.dto';
import { DeliveryContext, PipelineResult, AlertErrorType } from '../types';

/**
 * 消息处理管线服务
 *
 * 职责：
 * 1. 管线步骤：过滤 → 去重 → 历史记录 → 监控
 * 2. 单消息处理（直发路径）
 * 3. 聚合消息处理（聚合路径）
 * 4. 错误处理和降级回复
 *
 * 从 MessageService 拆分，专注于消息处理逻辑
 */
@Injectable()
export class MessagePipelineService {
  private readonly logger = new Logger(MessagePipelineService.name);

  constructor(
    // 子服务
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly historyService: MessageHistoryService,
    private readonly filterService: MessageFilterService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly agentGateway: AgentGatewayService,
    private readonly bookingDetection: BookingDetectionService,
    // 监控和告警
    private readonly monitoringService: MonitoringService,
    private readonly feishuAlertService: FeishuAlertService,
  ) {}

  // ========================================
  // 管线步骤
  // ========================================

  /**
   * 管线步骤 0: 处理 bot 自己发送的消息
   * 将 isSelf=true 的消息存储为 assistant 历史记录
   */
  async handleSelfMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content } = parsed;

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[自发消息] 消息内容为空，跳过存储 [${messageData.messageId}]`);
      return;
    }

    // 从历史记录中获取候选人昵称（因为 isSelf=true 时 contactName 是招募经理的名字）
    const candidateName = await this.getCandidateNameFromHistory(chatId);

    // 存储为 assistant 消息（包含元数据）
    const isRoom = Boolean(messageData.imRoomId);
    await this.historyService.addMessageToHistory(chatId, 'assistant', content, {
      messageId: messageData.messageId,
      candidateName,
      managerName: messageData.botUserId, // 统一使用 botUserId，避免与 user 消息的 managerName 不一致
      orgId: messageData.orgId,
      botId: messageData.botId,
      messageType: messageData.messageType,
      source: messageData.source,
      isRoom,
      imBotId: messageData.imBotId,
      imContactId: messageData.imContactId,
      contactType: messageData.contactType,
      isSelf: messageData.isSelf,
      payload: messageData.payload as Record<string, unknown>,
      avatar: messageData.avatar,
      externalUserId: messageData.externalUserId,
    });

    this.logger.log(
      `[自发消息] 已存储为 assistant 历史 [${messageData.messageId}]: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
    );
  }

  /**
   * 管线步骤 1: 消息过滤
   */
  async filterMessage(
    messageData: EnterpriseMessageCallbackDto,
  ): Promise<PipelineResult<{ content?: string }>> {
    const filterResult = await this.filterService.validate(messageData);

    if (!filterResult.pass) {
      return {
        continue: false,
        response: { success: true, message: `${filterResult.reason} ignored` },
      };
    }

    // 处理 historyOnly 模式（小组黑名单）：记录历史但不触发 AI 回复
    if (filterResult.historyOnly) {
      const parsed = MessageParser.parse(messageData);
      const { chatId, content, contactName } = parsed;
      const isRoom = Boolean(messageData.imRoomId);

      await this.historyService.addMessageToHistory(chatId, 'user', content, {
        messageId: messageData.messageId,
        candidateName: messageData.contactName || contactName,
        managerName: messageData.botUserId,
        orgId: messageData.orgId,
        botId: messageData.botId,
        messageType: messageData.messageType,
        source: messageData.source,
        isRoom,
        imBotId: messageData.imBotId,
        imContactId: messageData.imContactId,
        contactType: messageData.contactType,
        isSelf: messageData.isSelf,
        payload: messageData.payload as Record<string, unknown>,
        avatar: messageData.avatar,
        externalUserId: messageData.externalUserId,
      });

      this.logger.log(
        `[historyOnly] 消息已记录到历史但不触发AI回复 [${messageData.messageId}], ` +
          `chatId=${chatId}, contact=${contactName}, reason=${filterResult.reason}`,
      );

      return {
        continue: false,
        response: { success: true, message: 'Message recorded to history only' },
      };
    }

    return { continue: true, data: { content: filterResult.content } };
  }

  /**
   * 管线步骤 2: 消息去重（异步版本，使用 Redis）
   */
  async checkDuplicationAsync(messageData: EnterpriseMessageCallbackDto): Promise<PipelineResult> {
    const isProcessed = await this.deduplicationService.isMessageProcessedAsync(
      messageData.messageId,
    );
    if (isProcessed) {
      this.logger.log(`[消息去重] 消息 [${messageData.messageId}] 已处理过，跳过重复处理`);
      return {
        continue: false,
        response: { success: true, message: 'Duplicate message ignored' },
      };
    }

    return { continue: true };
  }

  /**
   * 管线步骤 3: 将用户消息记录到历史
   */
  async recordUserMessageToHistory(
    messageData: EnterpriseMessageCallbackDto,
    contentFromFilter?: string,
  ): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, contactName } = parsed;
    const content = contentFromFilter ?? parsed.content;
    const isRoom = Boolean(messageData.imRoomId);

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[历史记录] 消息内容为空，跳过记录历史 [${messageData.messageId}]`);
      return;
    }

    await this.historyService.addMessageToHistory(chatId, 'user', content, {
      messageId: messageData.messageId,
      candidateName: messageData.contactName || contactName,
      managerName: messageData.botUserId,
      orgId: messageData.orgId,
      botId: messageData.botId,
      messageType: messageData.messageType,
      source: messageData.source,
      isRoom,
      imBotId: messageData.imBotId,
      imContactId: messageData.imContactId,
      contactType: messageData.contactType,
      isSelf: messageData.isSelf,
      payload: messageData.payload as Record<string, unknown>,
      avatar: messageData.avatar,
      externalUserId: messageData.externalUserId,
    });
  }

  /**
   * 管线步骤 4: 记录监控
   */
  recordMessageReceived(messageData: EnterpriseMessageCallbackDto): void {
    const parsed = MessageParser.parse(messageData);
    const scenario = MessageParser.determineScenario(messageData);
    this.monitoringService.recordMessageReceived(
      messageData.messageId,
      parsed.chatId,
      parsed.imContactId,
      parsed.contactName,
      parsed.content,
      { scenario },
      parsed.managerName,
    );
  }

  // ========================================
  // 消息处理
  // ========================================

  /**
   * 处理单条消息（直发路径）
   */
  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content, contactName, messageId } = parsed;
    const scenario = MessageParser.determineScenario(messageData);

    try {
      await this.processMessageCore({
        primaryMessage: messageData,
        messageId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: true,
      });
    } catch (error) {
      const errorType: AlertErrorType = this.isAgentError(error) ? 'agent' : 'message';
      await this.handleProcessingError(error, parsed, { errorType, scenario });
    }
  }

  /**
   * 处理聚合后的消息（聚合路径）
   * 由 MessageProcessor 调用
   */
  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    if (messages.length === 0) return;

    const scenario = MessageParser.determineScenario(messages[0]);
    const lastMessage = messages[messages.length - 1];
    const parsed = MessageParser.parse(lastMessage);
    const { chatId, contactName } = parsed;
    const content = MessageParser.extractContent(lastMessage);

    this.logger.log(`[聚合处理][${chatId}] 处理 ${messages.length} 条消息`);

    try {
      await this.processMessageCore({
        primaryMessage: lastMessage,
        messageId: lastMessage.messageId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: false,
        batchContext: { batchId, allMessages: messages },
      });
    } catch (error) {
      this.logger.error(`聚合消息处理失败:`, error.message);

      const errorType: AlertErrorType = this.isAgentError(error) ? 'agent' : 'merge';
      await this.handleProcessingError(error, parsed, { errorType, scenario });

      // 标记其他消息为失败
      const handledMessageId = parsed.messageId;
      await Promise.all(
        messages
          .filter((m) => m.messageId !== handledMessageId)
          .map(async (message) => {
            await this.deduplicationService.markMessageAsProcessedAsync(message.messageId);
            this.monitoringService.recordFailure(
              message.messageId,
              error.message || '聚合处理失败',
              { scenario, alertType: errorType },
            );
          }),
      );

      throw error;
    }
  }

  // ========================================
  // 核心处理逻辑
  // ========================================

  /**
   * 消息处理核心逻辑
   * 统一处理单条消息和聚合消息的共同流程
   */
  private async processMessageCore(params: {
    primaryMessage: EnterpriseMessageCallbackDto;
    messageId: string;
    chatId: string;
    content: string;
    contactName: string;
    scenario: ScenarioType;
    parsed: ReturnType<typeof MessageParser.parse>;
    isSingleMessage: boolean;
    batchContext?: { batchId: string; allMessages: EnterpriseMessageCallbackDto[] };
  }): Promise<void> {
    const {
      messageId,
      chatId,
      content,
      contactName,
      scenario,
      parsed,
      isSingleMessage,
      batchContext,
    } = params;

    const logPrefix = isSingleMessage ? '' : '[聚合处理]';

    // 1. 获取历史消息（已预先写入当前消息，此处排除当前消息）
    const historyMessages = await this.historyService.getHistoryForContext(chatId, messageId);

    // 2. 调用 Agent
    const agentResult = await this.agentGateway.invoke({
      sessionId: chatId,
      userMessage: content,
      historyMessages,
      scenario,
      messageId,
      recordMonitoring: true,
      userId: params.primaryMessage.imContactId,
    });

    this.logger.log(
      `${logPrefix}[${contactName}] Agent 处理完成，耗时 ${agentResult.processingTime}ms，` +
        `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
    );

    // 3. 如果是降级响应，发送告警（需要人工介入）
    if (agentResult.isFallback) {
      this.sendFallbackAlert({
        contactName,
        userMessage: content,
        fallbackMessage: agentResult.reply.content,
        fallbackReason: agentResult.result?.fallbackInfo?.reason || 'Agent API 调用失败',
        scenario,
        chatId,
      });
    }

    // 4. 异步检测预约成功并处理通知（不阻塞主流程）
    this.bookingDetection.handleBookingSuccessAsync({
      chatId,
      contactName,
      userId: parsed.imContactId,
      managerId: parsed.imBotId,
      managerName: parsed.managerName,
      chatResponse: agentResult.reply.rawResponse,
    });

    // 5. 发送回复
    const deliveryContext = this.buildDeliveryContext(parsed);
    const deliveryResult = await this.deliveryService.deliverReply(
      agentResult.reply,
      deliveryContext,
      isSingleMessage,
    );

    // 6. 构建成功记录的元数据
    const successMetadata = this.buildSuccessMetadata(agentResult, deliveryResult, scenario);

    // 7. 标记消息为已处理并记录成功
    if (batchContext) {
      // 聚合路径：批量标记所有消息
      await this.markBatchMessagesSuccess(
        batchContext.allMessages,
        messageId,
        chatId,
        batchContext.batchId,
        successMetadata,
      );
    } else {
      // 单条路径：只标记当前消息
      this.monitoringService.recordSuccess(messageId, successMetadata);
      await this.deduplicationService.markMessageAsProcessedAsync(messageId);
      this.logger.debug(`[${contactName}] 消息 [${messageId}] 已标记为已处理`);
    }
  }

  /**
   * 构建成功记录的元数据
   */
  private buildSuccessMetadata(
    agentResult: Awaited<ReturnType<AgentGatewayService['invoke']>>,
    deliveryResult: { segmentCount: number },
    scenario: ScenarioType,
  ): Record<string, unknown> {
    const rawResponse = agentResult.reply.rawResponse;
    const requestBody = (agentResult.result as unknown as Record<string, unknown>)?.requestBody;
    const rawHttpResponse = agentResult.result.rawHttpResponse;

    return {
      scenario,
      tools: agentResult.reply.tools?.used,
      tokenUsage: agentResult.reply.usage?.totalTokens,
      replyPreview: agentResult.reply.content,
      replySegments: deliveryResult.segmentCount,
      isFallback: agentResult.isFallback,
      agentInvocation:
        requestBody && rawResponse
          ? {
              request: requestBody,
              response: rawResponse,
              isFallback: agentResult.isFallback,
              http: rawHttpResponse
                ? {
                    status: rawHttpResponse.status,
                    statusText: rawHttpResponse.statusText,
                    headers: rawHttpResponse.headers,
                  }
                : undefined,
            }
          : undefined,
    };
  }

  /**
   * 批量标记聚合消息为成功
   */
  private async markBatchMessagesSuccess(
    messages: EnterpriseMessageCallbackDto[],
    primaryMessageId: string,
    chatId: string,
    batchId: string,
    baseMetadata: Record<string, unknown>,
  ): Promise<void> {
    this.logger.debug(
      `[聚合处理][${chatId}] 开始标记 ${messages.length} 条消息为 success (batchId=${batchId}): [${messages.map((m) => m.messageId).join(', ')}]`,
    );

    await Promise.all(
      messages.map(async (message, index) => {
        this.logger.debug(
          `[聚合处理][${chatId}] 正在标记消息 ${index + 1}/${messages.length}: ${message.messageId}`,
        );

        await this.deduplicationService.markMessageAsProcessedAsync(message.messageId);

        // 所有消息都共享相同的 AI 响应元数据
        // isPrimary 标记哪条消息实际调用了 Agent
        this.monitoringService.recordSuccess(message.messageId, {
          ...baseMetadata,
          batchId,
          isPrimary: message.messageId === primaryMessageId,
        });

        this.logger.debug(
          `[聚合处理][${chatId}] 已标记消息 ${index + 1}/${messages.length}: ${message.messageId} (isPrimary=${message.messageId === primaryMessageId})`,
        );
      }),
    );

    this.logger.debug(
      `[聚合处理][${chatId}] 已标记 ${messages.length} 条消息为已处理 (batchId=${batchId})`,
    );
  }

  // ========================================
  // 辅助方法
  // ========================================

  /**
   * 判断错误是否为 Agent API 错误
   */
  private isAgentError(error: unknown): boolean {
    return (
      error instanceof AgentException ||
      Boolean((error as { isAgentError?: boolean })?.isAgentError)
    );
  }

  /**
   * 根据异常类型映射到告警级别
   *
   * 级别定义：
   * - CRITICAL: 用户无响应（消息发送失败）
   * - ERROR: 需要关注的错误（认证失败、配置错误）
   * - WARNING: 可自动恢复的错误（频率限制、上下文缺失）
   */
  private getAlertLevelFromError(error: unknown): AlertLevel {
    // 认证失败：需要人工干预修复 API Key
    if (error instanceof AgentAuthException) {
      return AlertLevel.ERROR;
    }

    // 频率限制：通常会自动恢复，但需要关注
    if (error instanceof AgentRateLimitException) {
      return AlertLevel.WARNING;
    }

    // 配置错误：需要人工干预修复配置
    if (error instanceof AgentConfigException) {
      return AlertLevel.ERROR;
    }

    // 上下文缺失：可能是临时问题，需要关注
    if (error instanceof AgentContextMissingException) {
      return AlertLevel.WARNING;
    }

    // 其他 Agent 错误：默认 ERROR
    if (error instanceof AgentException) {
      return AlertLevel.ERROR;
    }

    // 非 Agent 错误：默认 ERROR
    return AlertLevel.ERROR;
  }

  /**
   * 处理错误并发送降级回复
   */
  private async handleProcessingError(
    error: unknown,
    parsed: ReturnType<typeof MessageParser.parse>,
    options?: { errorType?: AlertErrorType; scenario?: ScenarioType },
  ): Promise<void> {
    const {
      chatId,
      content,
      contactName,
      messageId,
      token,
      imBotId,
      imContactId,
      imRoomId,
      _apiType,
    } = parsed;
    const scenario = options?.scenario || MessageParser.determineScenario();
    const errorType: AlertErrorType = options?.errorType || 'message';
    const errorMessage = error instanceof Error ? error.message : String(error);

    this.logger.error(`[${contactName}] 消息处理失败 [${messageId}]: ${errorMessage}`);

    // 记录失败
    this.monitoringService.recordFailure(messageId, errorMessage, {
      scenario,
      alertType: errorType,
    });

    // 发送告警（根据异常类型映射告警级别）
    const fallbackMessage = this.agentGateway.getFallbackMessage();
    const alertLevel = this.getAlertLevelFromError(error);

    // 从 error 对象中提取调试信息（由 AgentApiClientService 附加）
    const apiKey = (error as any)?.apiKey;
    const maskedApiKey = maskApiKey(apiKey);

    this.feishuAlertService
      .sendAlert({
        errorType,
        error: error instanceof Error ? error : new Error(errorMessage),
        conversationId: chatId,
        userMessage: content,
        contactName,
        apiEndpoint: '/api/v1/chat',
        scenario,
        fallbackMessage,
        level: alertLevel,
        // 添加 API Key 脱敏信息，便于排查 401 问题
        extra: maskedApiKey ? { apiKey: maskedApiKey } : undefined,
        // 注意：此处是异常处理告警，不需要 @ 琪琪
        // 只有 sendFallbackAlert（Agent 降级响应）才需要 @ 琪琪人工介入
      })
      .catch((alertError) => {
        this.logger.error(`告警发送失败: ${alertError.message}`);
      });

    // 发送降级回复
    try {
      const deliveryContext: DeliveryContext = {
        token,
        imBotId,
        imContactId,
        imRoomId,
        contactName,
        messageId,
        chatId,
        _apiType,
      };

      await this.deliveryService.deliverReply(
        {
          content: fallbackMessage,
          rawResponse: undefined,
        },
        deliveryContext,
        false,
      );

      this.logger.log(`[${contactName}] 已发送降级回复: "${fallbackMessage}"`);

      // 标记消息为已处理
      await this.deduplicationService.markMessageAsProcessedAsync(messageId);
    } catch (sendError) {
      const sendErrorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      this.logger.error(`[${contactName}] 发送降级回复失败: ${sendErrorMessage}`);

      // 🚨 CRITICAL: 用户完全无法收到任何回复，必须立即告警
      this.feishuAlertService
        .sendAlert({
          errorType: 'delivery',
          error: sendError instanceof Error ? sendError : new Error(sendErrorMessage),
          conversationId: chatId,
          userMessage: content,
          contactName, // 用户昵称，便于人工查找用户回复
          apiEndpoint: 'message-sender',
          scenario,
          level: AlertLevel.CRITICAL,
          title: '🚨 消息发送失败 - 用户无响应',
          extra: {
            originalError: errorMessage,
            fallbackMessage,
            messageId,
          },
        })
        .catch((alertError: Error) => {
          this.logger.error(`CRITICAL 告警发送失败: ${alertError.message}`);
        });
    }
  }

  /**
   * 构建发送上下文
   */
  private buildDeliveryContext(parsed: ReturnType<typeof MessageParser.parse>): DeliveryContext {
    return {
      token: parsed.token,
      imBotId: parsed.imBotId,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      contactName: parsed.contactName || '客户',
      messageId: parsed.messageId,
      chatId: parsed.chatId,
      _apiType: parsed._apiType,
    };
  }

  /**
   * 从历史记录中获取候选人昵称
   */
  private async getCandidateNameFromHistory(chatId: string): Promise<string | undefined> {
    try {
      const detail = await this.historyService.getHistoryDetail(chatId);
      if (!detail?.messages) {
        return undefined;
      }
      const userMessage = detail.messages.find((m) => m.role === 'user' && m.candidateName);
      return userMessage?.candidateName;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`获取候选人昵称失败 [${chatId}]: ${errorMessage}`);
      return undefined;
    }
  }

  /**
   * 发送降级响应告警
   * 当 Agent 返回降级响应时调用，通知相关人员人工介入
   */
  private sendFallbackAlert(params: {
    contactName: string;
    userMessage: string;
    fallbackMessage: string;
    fallbackReason: string;
    scenario: ScenarioType;
    chatId: string;
  }): void {
    const { contactName, userMessage, fallbackMessage, fallbackReason, scenario, chatId } = params;

    this.logger.warn(`[${contactName}] Agent 降级响应，原因: ${fallbackReason}，需要人工介入`);

    this.feishuAlertService
      .sendAlert({
        errorType: 'agent',
        message: fallbackReason,
        conversationId: chatId,
        userMessage,
        contactName,
        apiEndpoint: '/api/v1/chat',
        scenario,
        fallbackMessage,
        level: AlertLevel.ERROR,
        title: '🆘 小蛋糕出错了，需人工介入',
        // 消息降级场景 @ 琪琪，需要人工介入回复用户
        atUsers: [...ALERT_RECEIVERS.FALLBACK],
      })
      .catch((alertError) => {
        this.logger.error(`降级告警发送失败: ${alertError.message}`);
      });
  }
}
