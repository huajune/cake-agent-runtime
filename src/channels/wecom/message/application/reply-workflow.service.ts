import { Injectable, Logger } from '@nestjs/common';
import { ScenarioType } from '@enums/agent.enum';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { AgentRunnerService } from '@agent/runner.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ReplyNormalizer } from '../utils/reply-normalizer.util';
import { MessageParser } from '../utils/message-parser.util';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { DeliveryContext, AgentInvokeResult } from '../types';
import type { AgentError } from '@shared-types/agent-error.types';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { MessageDeliveryService } from '../delivery/delivery.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { MessageProcessingFailureService } from './message-processing-failure.service';

@Injectable()
export class ReplyWorkflowService {
  private readonly logger = new Logger(ReplyWorkflowService.name);

  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly runner: AgentRunnerService,
    private readonly monitoringService: MessageTrackingService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly processingFailureService: MessageProcessingFailureService,
  ) {}

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content, contactName, messageId } = parsed;
    const scenario = MessageParser.determineScenario();
    const traceId = messageId;

    try {
      await this.wecomObservability.startRequestTrace({
        traceId,
        primaryMessage: messageData,
        scenario,
        content,
      });
      await this.wecomObservability.updateDispatch(traceId, 'direct');
      await this.wecomObservability.markWorkerStart(traceId);
      await this.processMessageCore({
        primaryMessage: messageData,
        traceId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: true,
      });
    } catch (error) {
      const errorType = this.processingFailureService.inferErrorType(error, 'message');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        dispatchMode: 'direct',
        processedMessageIds: [messageData.messageId],
      });
    }
  }

  async processMergedMessages(
    messages: EnterpriseMessageCallbackDto[],
    batchId: string,
  ): Promise<void> {
    if (messages.length === 0) return;

    const scenario = MessageParser.determineScenario();
    const lastMessage = messages[messages.length - 1];
    const parsed = MessageParser.parse(lastMessage);
    const { chatId, contactName } = parsed;
    const content = this.wecomObservability.buildMergedRequestContent(messages);
    const traceId = batchId;

    this.logger.log(`[聚合处理][${chatId}] 处理 ${messages.length} 条消息`);

    try {
      await this.wecomObservability.startRequestTrace({
        traceId,
        primaryMessage: lastMessage,
        scenario,
        content,
        batchId,
        allMessages: messages,
      });
      await this.wecomObservability.updateDispatch(traceId, 'merged', batchId);
      await this.wecomObservability.markWorkerStart(traceId);
      await this.processMessageCore({
        primaryMessage: lastMessage,
        traceId,
        chatId,
        content,
        contactName,
        scenario,
        parsed,
        isSingleMessage: false,
        batchContext: { batchId, allMessages: messages },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`聚合消息处理失败:`, errorMessage);

      const errorType = this.processingFailureService.inferErrorType(error, 'merge');
      await this.processingFailureService.handleProcessingError(error, parsed, {
        errorType,
        scenario,
        traceId,
        batchId,
        dispatchMode: 'merged',
        processedMessageIds: messages.map((message) => message.messageId),
      });

      throw error;
    }
  }

  private async processMessageCore(params: {
    primaryMessage: EnterpriseMessageCallbackDto;
    traceId: string;
    chatId: string;
    content: string;
    contactName: string;
    scenario: ScenarioType;
    parsed: ReturnType<typeof MessageParser.parse>;
    isSingleMessage: boolean;
    batchContext?: { batchId: string; allMessages: EnterpriseMessageCallbackDto[] };
  }): Promise<void> {
    const {
      traceId,
      chatId,
      content,
      contactName,
      scenario,
      parsed,
      isSingleMessage,
      batchContext,
    } = params;

    const logPrefix = isSingleMessage ? '' : '[聚合处理]';
    const allMessages = batchContext?.allMessages ?? [params.primaryMessage];
    const imageUrls = allMessages
      .map((message) => MessageParser.extractImageUrl(message))
      .filter((url): url is string => url !== null);
    const imageMessageIds = allMessages
      .filter((message) => MessageParser.extractImageUrl(message) !== null)
      .map((message) => message.messageId);

    const { overrideModelId, effectiveModelId } =
      await this.runtimeConfig.resolveWecomChatModelSelection();

    const agentResult = await this.callAgent({
      sessionId: chatId,
      userMessage: content,
      scenario,
      messageId: traceId,
      recordMonitoring: true,
      userId: this.resolveAgentUserId(params.primaryMessage, parsed),
      corpId: this.resolveCorpId(params.primaryMessage),
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
      botUserId: params.primaryMessage.botUserId,
      contactName: parsed.contactName,
      botImId: params.primaryMessage.imBotId,
      token: parsed.token,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      apiType: parsed._apiType,
      modelId: overrideModelId,
      effectiveModelId,
    });

    this.logger.log(
      `${logPrefix}[${contactName}] Agent 处理完成，耗时 ${agentResult.processingTime}ms，` +
        `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
    );

    if (agentResult.isFallback) {
      this.processingFailureService.sendFallbackAlert({
        contactName,
        botUserName: parsed.managerName,
        userMessage: content,
        fallbackMessage: agentResult.reply.content,
        fallbackReason: 'Agent 返回降级响应',
        scenario,
        chatId,
        imBotId: params.primaryMessage.imBotId,
      });
    }

    const deliveryContext = this.buildDeliveryContext(parsed, traceId);
    const deliveryResult = await this.deliveryService.deliverReply(
      agentResult.reply,
      deliveryContext,
      true,
    );

    const successMetadata = await this.buildSuccessMetadata(
      traceId,
      agentResult,
      deliveryResult,
      scenario,
      batchContext?.batchId,
    );

    this.monitoringService.recordSuccess(traceId, successMetadata);
    await this.markMessagesAsProcessed(
      batchContext
        ? batchContext.allMessages.map((message) => message.messageId)
        : [params.primaryMessage.messageId],
    );

    if (!batchContext) {
      this.logger.debug(`[${contactName}] 请求流水 [${traceId}] 已标记为已处理`);
    }
  }

  private async buildSuccessMetadata(
    traceId: string,
    agentResult: AgentInvokeResult,
    deliveryResult: { segmentCount: number },
    scenario: ScenarioType,
    batchId?: string,
  ): Promise<MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string }> {
    return this.wecomObservability.buildSuccessMetadata(traceId, {
      scenario,
      batchId,
      replyPreview: agentResult.reply.content,
      replySegments: deliveryResult.segmentCount,
      extraResponse: {
        processingTimeMs: agentResult.processingTime,
      },
    });
  }

  private async markMessagesAsProcessed(messageIds: string[]): Promise<void> {
    await Promise.all(
      messageIds.map(async (messageId) => {
        await this.deduplicationService.markMessageAsProcessedAsync(messageId).catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[请求流水] 去重标记失败 [${messageId}]: ${errorMessage}`);
        });
      }),
    );
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
    contactName?: string;
    botImId?: string;
    token?: string;
    imContactId?: string;
    imRoomId?: string;
    apiType?: 'enterprise' | 'group';
    modelId?: string;
    effectiveModelId?: string;
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
        await this.wecomObservability.markAiStart(messageId);
        await this.wecomObservability.recordAgentRequest(messageId, {
          sessionId: params.sessionId,
          userId,
          corpId,
          scenario,
          userMessage,
          imageUrls: params.imageUrls,
          imageMessageIds: params.imageMessageIds,
          strategySource: 'released',
          modelId: params.effectiveModelId,
          modelIdSource: params.modelId ? 'runtime_config' : 'default_route',
        });
        shouldRecordAiEnd = true;
      }

      const result = await this.runner.invoke({
        userMessage,
        userId,
        corpId,
        sessionId: params.sessionId,
        scenario,
        contactName: params.contactName,
        imageUrls: params.imageUrls,
        imageMessageIds: params.imageMessageIds,
        botUserId: params.botUserId,
        botImId: params.botImId,
        token: params.token,
        imContactId: params.imContactId,
        imRoomId: params.imRoomId,
        apiType: params.apiType,
        modelId: params.modelId,
      });

      const processingTime = Date.now() - startTime;
      const content = this.normalizeContent(result.text);
      if (!content) {
        const emptyResponseError = new Error('Agent 返回空响应') as AgentError;
        emptyResponseError.isAgentError = true;
        emptyResponseError.agentMeta = {
          sessionId: params.sessionId,
          userId,
          messageCount: 1,
        };
        throw emptyResponseError;
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
        await this.wecomObservability.recordAgentResult(messageId, invokeResult);
      }

      return invokeResult;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error(`Agent 调用异常: ${errorMessage}`);
      throw error;
    } finally {
      if (shouldRecordAiEnd && messageId) {
        await this.wecomObservability.markAiEnd(messageId);
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

  private resolveAgentUserId(
    messageData: EnterpriseMessageCallbackDto,
    parsed: ReturnType<typeof MessageParser.parse>,
  ): string {
    return parsed.imContactId || messageData.externalUserId || parsed.chatId;
  }

  private resolveCorpId(messageData: EnterpriseMessageCallbackDto): string {
    return messageData.orgId || 'default';
  }

  private buildDeliveryContext(
    parsed: ReturnType<typeof MessageParser.parse>,
    traceId?: string,
  ): DeliveryContext {
    return {
      token: parsed.token,
      imBotId: parsed.imBotId,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      contactName: parsed.contactName || '客户',
      messageId: traceId ?? parsed.messageId,
      chatId: parsed.chatId,
      _apiType: parsed._apiType,
    };
  }
}
