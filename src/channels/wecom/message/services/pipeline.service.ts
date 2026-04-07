import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { AlertLevel } from '@infra/feishu/interfaces/interface';
import { maskApiKey } from '@infra/utils/string.util';
import { ScenarioType } from '@enums/agent.enum';
import { AgentRunnerService } from '@agent/runner.service';
import { supportsVision } from '@providers/types';

// 导入子服务
import { MessageDeduplicationService } from './deduplication.service';
import { MessageFilterService } from './filter.service';
import { MessageDeliveryService } from './delivery.service';
import { ImageDescriptionService } from './image-description.service';
import { WecomMessageObservabilityService } from './wecom-message-observability.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ChatMessageInput } from '@biz/message/types/message.types';

// 导入工具和类型
import { MessageParser } from '../utils/message-parser.util';
import { ReplyNormalizer } from '../utils/reply-normalizer.util';
import { EnterpriseMessageCallbackDto } from '../message-callback.dto';
import {
  DeliveryContext,
  AlertErrorType,
  AgentInvokeResult,
  FallbackMessageOptions,
  DeliveryFailureError,
  toStorageContactType,
  toStorageMessageSource,
  toStorageMessageType,
} from '../message.types';

/**
 * 消息处理管线服务
 *
 * 对外暴露：
 *   execute(dto)             — 完整管线入口（MessageService 唯一调用点）
 *   processSingleMessage()   — 直发路径
 *   processMergedMessages()  — 聚合路径（MessageProcessor 调用）
 *
 * 管线步骤全部私有，由 execute() 内部编排：
 *   step0: handleSelfMessage
 *   step1: filterMessage（只判断，不写副作用）
 *   step2: checkDuplication
 *   step3: recordHistory（含 historyOnly 分支）
 *   step4: recordMonitoring
 */
@Injectable()
export class MessagePipelineService {
  private readonly logger = new Logger(MessagePipelineService.name);

  private readonly defaultFallbackMessages: string[] = [
    '我确认下哈，马上回你~',
    '我这边查一下，稍等~',
    '让我看看哈，很快~',
    '这块我再核实下，确认好马上告诉你哈~',
    '这个涉及几个细节，我确认下再回你',
    '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
  ];

  constructor(
    // 子服务
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly chatSession: ChatSessionService,
    private readonly filterService: MessageFilterService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly imageDescription: ImageDescriptionService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    // Agent 编排
    private readonly runner: AgentRunnerService,
    private readonly configService: ConfigService,
    // 监控和告警
    private readonly monitoringService: MessageTrackingService,
    private readonly alertService: FeishuAlertService,
  ) {}

  // ========================================
  // 公开入口
  // ========================================

  /**
   * 消息处理管线入口（MessageService 的唯一调用点）
   *
   * 返回值：
   *   shouldDispatch=true  — 需要触发 AI，由 MessageService 决定是否 dispatch
   *   shouldDispatch=false — 管线已终止，response 是最终响应
   */
  async execute(messageData: EnterpriseMessageCallbackDto): Promise<{
    shouldDispatch: boolean;
    response: { success: boolean; message: string };
    content?: string;
  }> {
    // step 0: bot 自发消息
    if (messageData.isSelf === true) {
      await this.handleSelfMessage(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      return { shouldDispatch: false, response: { success: true, message: 'Self message stored' } };
    }

    // step 1: 过滤（只判断，不写副作用）
    const filterResult = await this.filterService.validate(messageData);

    if (!filterResult.pass) {
      return {
        shouldDispatch: false,
        response: { success: true, message: `${filterResult.reason} ignored` },
      };
    }

    // step 2: 去重
    const isProcessed = await this.deduplicationService.isMessageProcessedAsync(
      messageData.messageId,
    );
    if (isProcessed) {
      this.logger.log(`[消息去重] 消息 [${messageData.messageId}] 已处理过，跳过重复处理`);
      return {
        shouldDispatch: false,
        response: { success: true, message: 'Duplicate message ignored' },
      };
    }

    if (filterResult.historyOnly) {
      await this.recordUserMessageToHistory(messageData, filterResult.content);
      const parsed = MessageParser.parse(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      this.logger.log(
        `[historyOnly] 消息已记录到历史但不触发AI回复 [${messageData.messageId}], ` +
          `chatId=${parsed.chatId}, contact=${parsed.contactName}, reason=${filterResult.reason}`,
      );
      return {
        shouldDispatch: false,
        response: { success: true, message: 'Message recorded to history only' },
      };
    }

    // step 4: 监控（仅记录会进入 AI/自动回复链路的消息）
    this.recordMessageReceived(messageData, filterResult.content);

    try {
      // step 3: 写历史
      await this.recordUserMessageToHistory(messageData, filterResult.content);
      this.wecomObservability.markHistoryStored(messageData.messageId);

      // step 3.5: 图片描述
      // 需要提前写入 DB 的情况：主模型不支持 vision
      const imgUrl = MessageParser.extractImageUrl(messageData);
      const chatModelId = this.configService.get<string>('AGENT_CHAT_MODEL') || '';
      const shouldDescribeBeforeAgent = imgUrl !== null && !supportsVision(chatModelId);
      if (imgUrl && shouldDescribeBeforeAgent) {
        await this.imageDescription.describeAndUpdateSync(messageData.messageId, imgUrl);
        this.wecomObservability.markImagePrepared(messageData.messageId);
      }
    } catch (error) {
      const parsed = MessageParser.parse(messageData);
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureMetadata = this.wecomObservability.buildFailureMetadata(messageData.messageId, {
        scenario: MessageParser.determineScenario(),
        errorType: 'message',
        errorMessage,
        isPrimary: true,
        extraResponse: {
          phase: 'pre-dispatch',
          chatId: parsed.chatId,
        },
      });
      this.monitoringService.recordFailure(messageData.messageId, errorMessage, failureMetadata);
      throw error;
    }

    return {
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
      content: filterResult.content,
    };
  }

  // ========================================
  // 管线步骤（全部私有）
  // ========================================

  /**
   * step 0: 处理 bot 自己发送的消息，存储为 assistant 历史
   */
  private async handleSelfMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
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
    const assistantMsg: ChatMessageInput = {
      chatId,
      messageId: messageData.messageId,
      role: 'assistant',
      content,
      timestamp: this.resolveStoredTimestamp(parsed.timestamp),
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
    };
    await this.chatSession.saveMessage(assistantMsg);

    this.logger.log(
      `[自发消息] 已存储为 assistant 历史 [${messageData.messageId}]: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
    );
  }

  /**
   * step 3: 将用户消息记录到历史
   */
  private async recordUserMessageToHistory(
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

    const userMsg: ChatMessageInput = {
      chatId,
      messageId: messageData.messageId,
      role: 'user',
      content,
      timestamp: this.resolveStoredTimestamp(parsed.timestamp),
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
    };
    await this.chatSession.saveMessage(userMsg);
  }

  /**
   * step 4: 记录监控
   */
  private recordMessageReceived(
    messageData: EnterpriseMessageCallbackDto,
    contentFromFilter?: string,
  ): void {
    const parsed = MessageParser.parse(messageData);
    const scenario = MessageParser.determineScenario();
    const content = contentFromFilter ?? parsed.content ?? '';
    const imageUrl = MessageParser.extractImageUrl(messageData);
    this.wecomObservability.startTrace({
      messageId: messageData.messageId,
      chatId: parsed.chatId,
      userId: parsed.imContactId,
      userName: parsed.contactName,
      managerName: parsed.managerName,
      scenario,
      content,
      imageCount: imageUrl ? 1 : 0,
      messageType: toStorageMessageType(messageData.messageType),
      messageSource: toStorageMessageSource(messageData.source),
      contactType: toStorageContactType(messageData.contactType),
    });
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
    const scenario = MessageParser.determineScenario();

    try {
      this.wecomObservability.updateDispatch(messageId, 'direct');
      this.wecomObservability.markWorkerStart(messageId);
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
      const errorType: AlertErrorType = this.isAgentError(error)
        ? 'agent'
        : this.isDeliveryError(error)
          ? 'delivery'
          : 'message';
      await this.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        isPrimary: true,
        dispatchMode: 'direct',
      });
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

    const scenario = MessageParser.determineScenario();
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

      const errorType: AlertErrorType = this.isAgentError(error)
        ? 'agent'
        : this.isDeliveryError(error)
          ? 'delivery'
          : 'merge';
      await this.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        isPrimary: true,
        batchId,
        dispatchMode: 'merged',
      });

      // 标记其他消息为失败
      const handledMessageId = parsed.messageId;
      await Promise.all(
        messages
          .filter((m) => m.messageId !== handledMessageId)
          .map(async (message) => {
            await this.deduplicationService.markMessageAsProcessedAsync(message.messageId);
            const metadata = this.wecomObservability.buildFailureMetadata(message.messageId, {
              scenario,
              errorType,
              errorMessage: error.message || '聚合处理失败',
              isPrimary: false,
              batchId,
              extraResponse: {
                phase: 'merged-secondary',
                primaryMessageId: handledMessageId,
              },
            });
            this.monitoringService.recordFailure(
              message.messageId,
              error.message || '聚合处理失败',
              metadata,
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

    // 1. 调用 Agent（历史消息由 ShortTermService 内部读取，当前消息已在 step3 写入 DB）
    // 提取图片 URL（如有），用于多模态传入 Agent
    // 聚合路径：从所有消息中收集图片；单条路径：只看当前消息
    const allMessages = batchContext?.allMessages ?? [params.primaryMessage];
    const imageUrls = allMessages
      .map((msg) => MessageParser.extractImageUrl(msg))
      .filter((url): url is string => url !== null);

    // 收集图片消息 ID（供 save_image_description 工具回写 DB）
    const imageMessageIds = allMessages
      .filter((msg) => MessageParser.extractImageUrl(msg) !== null)
      .map((msg) => msg.messageId);

    const agentResult = await this.callAgent({
      sessionId: chatId,
      userMessage: content,
      scenario,
      messageId,
      recordMonitoring: true,
      userId: this.resolveAgentUserId(params.primaryMessage, parsed),
      corpId: this.resolveCorpId(params.primaryMessage),
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
      botUserId: params.primaryMessage.botUserId,
      botImId: params.primaryMessage.imBotId,
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
        fallbackReason: 'Agent 返回降级响应',
        scenario,
        chatId,
      });
    }

    // 4. 发送回复
    const deliveryContext = this.buildDeliveryContext(parsed);
    const deliveryResult = await this.deliveryService.deliverReply(
      agentResult.reply,
      deliveryContext,
      true,
    );

    // 5. 构建成功记录的元数据
    const successMetadata = this.buildSuccessMetadata(
      messageId,
      agentResult,
      deliveryResult,
      scenario,
    );

    // 6. 标记消息为已处理并记录成功
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
    messageId: string,
    agentResult: AgentInvokeResult,
    deliveryResult: { segmentCount: number },
    scenario: ScenarioType,
  ): Record<string, unknown> {
    return this.wecomObservability.buildSuccessMetadata(messageId, {
      scenario,
      isPrimary: true,
      replyPreview: agentResult.reply.content,
      replySegments: deliveryResult.segmentCount,
      extraResponse: {
        processingTimeMs: agentResult.processingTime,
      },
    }) as Record<string, unknown>;
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

        const isPrimary = message.messageId === primaryMessageId;
        this.wecomObservability.updateDispatch(message.messageId, 'merged', batchId);
        const metadata = isPrimary
          ? {
              ...baseMetadata,
              batchId,
              isPrimary: true,
            }
          : this.wecomObservability.buildSuccessMetadata(message.messageId, {
              scenario: ((baseMetadata.scenario as string) ||
                'candidate-consultation') as ScenarioType,
              isPrimary: false,
              batchId,
              extraResponse: {
                phase: 'merged-secondary',
                primaryMessageId,
              },
            });
        this.monitoringService.recordSuccess(message.messageId, metadata);

        this.logger.debug(
          `[聚合处理][${chatId}] 已标记消息 ${index + 1}/${messages.length}: ${message.messageId} (isPrimary=${isPrimary})`,
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
    return Boolean((error as { isAgentError?: boolean })?.isAgentError);
  }

  private isDeliveryError(error: unknown): error is DeliveryFailureError {
    return error instanceof DeliveryFailureError;
  }

  /**
   * 根据异常类型映射到告警级别
   */
  private getAlertLevelFromError(error: unknown): AlertLevel {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === HttpStatus.TOO_MANY_REQUESTS) return AlertLevel.WARNING;
    }
    return AlertLevel.ERROR;
  }

  /**
   * 处理错误并发送降级回复
   */
  private async handleProcessingError(
    error: unknown,
    parsed: ReturnType<typeof MessageParser.parse>,
    options?: {
      errorType?: AlertErrorType;
      scenario?: ScenarioType;
      isPrimary?: boolean;
      batchId?: string;
      dispatchMode?: 'direct' | 'merged';
    },
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
    const isPrimary = options?.isPrimary ?? true;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const deliveryError = this.isDeliveryError(error) ? error : null;

    this.logger.error(`[${contactName}] 消息处理失败 [${messageId}]: ${errorMessage}`);

    // 发送告警（根据异常类型映射告警级别）
    const fallbackMessage = this.getFallbackMessage();
    const alertLevel = this.getAlertLevelFromError(error);

    // 从 error 对象中提取调试信息（由 Agent 服务附加）
    const apiKey = (error as any)?.apiKey;
    const maskedApiKey = maskApiKey(apiKey);

    if (!deliveryError) {
      this.alertService
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
          // 注意：此处是异常处理告警，不需要 @ 人
        })
        .catch((alertError) => {
          this.logger.error(`告警发送失败: ${alertError.message}`);
        });
    }

    if ((deliveryError?.result.deliveredSegments ?? 0) > 0) {
      this.logger.warn(`[${contactName}] 回复已部分发送，跳过降级回复 [${messageId}]`);
      const failureMetadata = this.wecomObservability.buildFailureMetadata(messageId, {
        scenario,
        errorType,
        errorMessage,
        isPrimary,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'delivery-partial',
          dispatchMode: options?.dispatchMode,
          delivery: deliveryError?.result,
        },
      });
      this.monitoringService.recordFailure(messageId, errorMessage, failureMetadata);
      return;
    }

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

      this.wecomObservability.markFallbackStart(messageId, fallbackMessage);
      await this.deliveryService.deliverReply({ content: fallbackMessage }, deliveryContext, false);
      this.wecomObservability.markFallbackEnd(messageId, {
        success: true,
        deliveredSegments: 1,
        failedSegments: 0,
      });

      this.logger.log(`[${contactName}] 已发送降级回复: "${fallbackMessage}"`);

      // 标记消息为已处理
      await this.deduplicationService.markMessageAsProcessedAsync(messageId);

      const failureMetadata = this.wecomObservability.buildFailureMetadata(messageId, {
        scenario,
        errorType,
        errorMessage,
        isPrimary,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'fallback-delivered',
          dispatchMode: options?.dispatchMode,
        },
      });
      this.monitoringService.recordFailure(messageId, errorMessage, failureMetadata);
    } catch (sendError) {
      const sendErrorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      const deliveryFailure = this.isDeliveryError(sendError) ? sendError.result : undefined;
      this.wecomObservability.markFallbackEnd(messageId, {
        success: false,
        totalTime: deliveryFailure?.totalTime,
        deliveredSegments: deliveryFailure?.deliveredSegments,
        failedSegments: deliveryFailure?.failedSegments,
        error: sendErrorMessage,
      });
      this.logger.error(`[${contactName}] 发送降级回复失败: ${sendErrorMessage}`);

      // 🚨 CRITICAL: 用户完全无法收到任何回复，必须立即告警
      this.alertService
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

      const failureMetadata = this.wecomObservability.buildFailureMetadata(messageId, {
        scenario,
        errorType,
        errorMessage,
        isPrimary,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'fallback-failed',
          fallbackSendError: sendErrorMessage,
          dispatchMode: options?.dispatchMode,
        },
      });
      this.monitoringService.recordFailure(messageId, errorMessage, failureMetadata);
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
      const detail = await this.chatSession.getChatSessionMessages(chatId);
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

  // ========================================
  // Agent 调用（原 AgentGatewayService）
  // ========================================

  private getFallbackMessage(options?: FallbackMessageOptions): string {
    if (options?.customMessage) return options.customMessage;

    const envMessage = this.configService.get<string>('AGENT_FALLBACK_MESSAGE', '');
    if (envMessage) return envMessage;

    if (options?.random === false) return this.defaultFallbackMessages[0];

    const index = Math.floor(Math.random() * this.defaultFallbackMessages.length);
    return this.defaultFallbackMessages[index];
  }

  private async callAgent(params: {
    sessionId: string;
    userMessage: string;
    scenario?: string;
    messageId?: string;
    recordMonitoring?: boolean;
    userId: string;
    corpId: string;
    imageUrls?: string[];
    imageMessageIds?: string[];
    botUserId?: string;
    botImId?: string;
  }): Promise<AgentInvokeResult> {
    const {
      userMessage,
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      if (recordMonitoring && messageId) {
        this.wecomObservability.markAiStart(messageId);
        this.wecomObservability.recordAgentRequest(messageId, {
          sessionId: params.sessionId,
          userId,
          corpId,
          scenario,
          userMessage,
          imageUrls: params.imageUrls,
          imageMessageIds: params.imageMessageIds,
          strategySource: 'released',
        });
        shouldRecordAiEnd = true;
      }

      const result = await this.runner.invoke({
        userMessage,
        userId,
        corpId,
        sessionId: params.sessionId,
        scenario,
        imageUrls: params.imageUrls,
        imageMessageIds: params.imageMessageIds,
        botUserId: params.botUserId,
        botImId: params.botImId,
      });

      const processingTime = Date.now() - startTime;

      const content = this.normalizeContent(result.text);
      if (!content) {
        throw new Error('Agent 返回空响应');
      }

      this.logger.log(
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${result.usage?.totalTokens || 'N/A'}`,
      );

      const invokeResult = {
        reply: { content, reasoning: result.reasoning, usage: result.usage },
        isFallback: false,
        processingTime,
        toolCalls: result.toolCalls,
      };
      if (recordMonitoring && messageId) {
        this.wecomObservability.recordAgentResult(messageId, invokeResult);
      }

      return invokeResult;
    } catch (error) {
      this.logger.error(`Agent 调用异常: ${error.message}`);
      throw error;
    } finally {
      if (shouldRecordAiEnd && messageId) {
        this.wecomObservability.markAiEnd(messageId);
      }
    }
  }

  private normalizeContent(rawContent: string): string {
    if (ReplyNormalizer.needsNormalization(rawContent)) {
      const normalized = ReplyNormalizer.normalize(rawContent);
      this.logger.debug(
        `[ReplyNormalizer] 已清洗回复: "${rawContent.substring(0, 50)}..." → "${normalized.substring(0, 50)}..."`,
      );
      return normalized;
    }
    return rawContent;
  }

  private resolveStoredTimestamp(timestamp: number): number {
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }

  private resolveAgentUserId(
    messageData: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
  ): string {
    return parsed.imContactId || messageData.externalUserId || parsed.chatId;
  }

  private resolveCorpId(messageData: EnterpriseMessageCallbackDto): string {
    return messageData.orgId || 'default';
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

    this.alertService
      .sendAlert({
        errorType: 'agent_fallback',
        title: '需要人工介入',
        error: new Error(fallbackReason),
        contactName,
        userMessage,
        fallbackMessage,
        scenario,
        conversationId: chatId,
        apiEndpoint: '/api/v1/chat',
        level: AlertLevel.WARNING,
        atAll: true,
      })
      .catch((alertError) => {
        this.logger.error(`降级告警发送失败: ${alertError.message}`);
      });
  }
}
