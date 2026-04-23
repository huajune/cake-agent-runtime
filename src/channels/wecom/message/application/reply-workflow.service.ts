import { Injectable, Logger } from '@nestjs/common';
import { CallerKind, ScenarioType } from '@enums/agent.enum';
import { MessageType } from '@enums/message-callback.enum';
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
import { SimpleMergeService } from '../runtime/simple-merge.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { MessageProcessingFailureService } from './message-processing-failure.service';
import { PreAgentRiskInterceptService } from './pre-agent-risk-intercept.service';
import type { AgentThinkingConfig } from '@agent/agent-run.types';

/**
 * 触发后会产生不可逆副作用的工具集合。
 *
 * 首次 Agent 调用若命中其中任一工具（无论 result.success 如何），
 * 视为"本轮副作用已固化"，直接投递首次回复，跳过 replay 检测：
 * - `advance_stage`   procedural memory DB 直写 currentStage
 * - `invite_to_group` 企业级 addMember 外部 API + session facts 直写 invitedGroups
 * - `duliday_interview_booking` 杜力岱预约外部 API + recruitment_cases 建行 + 失败侧暂停托管
 *
 * 若 replay 丢弃首次回复，上述副作用已落地但用户未收到回复，会造成严重错乱：
 * - 阶段错位（procedural 被推进但 Agent 二次生成以为还在前一阶段）
 * - 群邀请已发但无解释
 * - 面试已预约但 Agent 二次生成重复尝试
 *
 * Agent 生成期间到达的新消息会留在 Redis pending list 里，
 * 由 MessageProcessor.handleProcessJob 末尾的 `checkAndProcessNewMessages`
 * 补建 follow-up job 在下一轮独立处理。
 */
const REPLAY_BLOCKING_TOOL_NAMES: ReadonlySet<string> = new Set([
  'advance_stage',
  'invite_to_group',
  'duliday_interview_booking',
]);

function collectBlockingTools(toolCalls: AgentInvokeResult['toolCalls']): string[] {
  if (!toolCalls || toolCalls.length === 0) return [];
  const hit = new Set<string>();
  for (const call of toolCalls) {
    if (REPLAY_BLOCKING_TOOL_NAMES.has(call.toolName)) {
      hit.add(call.toolName);
    }
  }
  return Array.from(hit);
}

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
    private readonly preAgentRiskIntercept: PreAgentRiskInterceptService,
    private readonly simpleMergeService: SimpleMergeService,
  ) {}

  async processSingleMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content, contactName, messageId } = parsed;
    const scenario = MessageParser.determineScenario();
    const traceId = messageId;

    try {
      // trace 通常已在入口 acceptInboundMessage.prepareForDispatch 创建。
      // 若仍不存在（异常兜底），此处补建。
      if (!(await this.wecomObservability.hasTrace(traceId))) {
        await this.wecomObservability.startRequestTrace({
          traceId,
          primaryMessage: messageData,
          scenario,
          content,
        });
      }
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
        mergeWindowMs: this.runtimeConfig.getMergeDelayMs(),
      });
      // 把各条源消息 trace 里的前置埋点合并到 batch trace，避免 Queue 把前置耗时吞掉
      await this.wecomObservability.mergePrepTimingsFromSources(
        traceId,
        messages.map((message) => message.messageId),
      );
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
    const { traceId, chatId, contactName, scenario, parsed, isSingleMessage, batchContext } =
      params;

    const logPrefix = isSingleMessage ? '' : '[聚合处理]';
    // 重跑会扩展本轮消息集合，这几个字段需要是 let。
    let allMessages: EnterpriseMessageCallbackDto[] = batchContext?.allMessages ?? [
      params.primaryMessage,
    ];
    let content = params.content;
    let imageUrls = this.collectImageUrls(allMessages);
    let imageMessageIds = this.collectImageMessageIds(allMessages);
    let visualMessageTypes = this.buildVisualMessageTypes(allMessages);
    let shortTermEndTimeInclusive = this.resolveShortTermEndTimeInclusive(allMessages);

    const { overrideModelId, thinking } = await this.runtimeConfig.resolveWecomChatModelSelection();

    // 前置风险同步预检：命中高置信度关键词即同步执行暂停+告警，
    // 但不短路 Agent——本轮安抚回复仍由 Agent 以招募者身份自主生成，
    // 避免任何预设话术暴露机器人/托管身份。
    const precheckResult = await this.preAgentRiskIntercept.precheck({
      messageData: params.primaryMessage,
      content,
    });
    if (precheckResult.hit) {
      this.logger.warn(
        `${logPrefix}[${contactName}] 前置风险预检命中: label=${precheckResult.label}, chatId=${chatId}`,
      );
    }

    const agentCallParams = {
      sessionId: chatId,
      scenario,
      messageId: traceId,
      recordMonitoring: true,
      userId: this.resolveAgentUserId(params.primaryMessage, parsed),
      corpId: this.resolveCorpId(params.primaryMessage),
      botUserId: params.primaryMessage.botUserId,
      contactName: parsed.contactName,
      botImId: params.primaryMessage.imBotId,
      externalUserId: parsed.externalUserId,
      token: parsed.token,
      imContactId: parsed.imContactId,
      imRoomId: parsed.imRoomId,
      apiType: parsed._apiType,
      modelId: overrideModelId,
      thinking,
    } as const;

    // 首次调用延迟 turn-end：若随后检测到新消息会走 replay 丢弃本次回复，
    // 记忆投影/事实提取也必须一同被丢弃，否则会把「未发出的回复」污染到 session 记忆里。
    let agentResult = await this.callAgent({
      ...agentCallParams,
      userMessage: content,
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
      visualMessageTypes:
        Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
      shortTermEndTimeInclusive,
      deferTurnEnd: true,
    });

    this.logger.log(
      `${logPrefix}[${contactName}] Agent 处理完成，耗时 ${agentResult.processingTime}ms，` +
        `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
    );

    // 副作用工具短路：首次调用若命中 advance_stage / invite_to_group /
    // duliday_interview_booking 中任一个，就视为本轮已经在外部系统留下了
    // 不可撤销的痕迹——不去 drain pending，直接投递首次回复。
    // Agent 生成期间到达的新消息仍留在 Redis pending list 里，由
    // MessageProcessor 末尾的 checkAndProcessNewMessages 补建 follow-up
    // job 在下一轮独立处理。
    const blockingTools = collectBlockingTools(agentResult.toolCalls);
    const replayBlocked = blockingTools.length > 0;

    if (replayBlocked) {
      this.logger.warn(
        `${logPrefix}[${contactName}][Replay-Skip] 首次调用命中不可逆工具 [${blockingTools.join(
          ',',
        )}]，跳过 replay 检测，直接投递首次回复 (chatId=${chatId})`,
      );
      if (agentResult.runTurnEnd) {
        void agentResult.runTurnEnd().catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[${contactName}] turn-end lifecycle 执行失败: ${errorMessage}`);
        });
        agentResult.runTurnEnd = undefined;
      }
    } else {
      // 投递前重跑：Agent 生成期间若用户又发了新消息，丢弃本次回复，合并新消息重跑一次。
      // 只允许一次重跑——第二次生成期间到的新消息交给投递后的 follow-up job 处理，避免无限重跑。
      const newMessages = await this.fetchPendingSinceAgentStart(chatId);
      if (newMessages.length > 0) {
        this.logger.warn(
          `${logPrefix}[${contactName}][Replay] 检测到 ${newMessages.length} 条新消息，丢弃首次回复并重新调用 Agent (chatId=${chatId})`,
        );
        // 丢弃首次的 runTurnEnd——它承载了将首次回复写入 session 记忆的副作用。
        // 下面第二次 callAgent 使用默认 deferTurnEnd=false，runner 内部会 fire-and-forget 触发。
        agentResult.runTurnEnd = undefined;

        allMessages = [...allMessages, ...newMessages];
        content = this.wecomObservability.buildMergedRequestContent(allMessages);
        imageUrls = this.collectImageUrls(allMessages);
        imageMessageIds = this.collectImageMessageIds(allMessages);
        visualMessageTypes = this.buildVisualMessageTypes(allMessages);
        shortTermEndTimeInclusive = this.resolveShortTermEndTimeInclusive(allMessages);
        await this.wecomObservability.updateRequestMessages(traceId, {
          messages: allMessages,
          content,
          mergeWindowMs: this.runtimeConfig.getMergeDelayMs(),
        });

        // Replay 合入的新消息在 intake 时已写了一条 processing 流水，本轮的终态只会
        // 回写到 traceId 那一行。若不在这里回收，这些源记录会一直停在「处理中」，
        // 只能等 30 分钟的 timeoutStuckRecords 兜底清理。
        await this.wecomObservability.mergePrepTimingsFromSources(
          traceId,
          newMessages.map((message) => message.messageId),
        );

        agentResult = await this.callAgent({
          ...agentCallParams,
          userMessage: content,
          imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
          imageMessageIds: imageMessageIds.length > 0 ? imageMessageIds : undefined,
          visualMessageTypes:
            Object.keys(visualMessageTypes).length > 0 ? visualMessageTypes : undefined,
          shortTermEndTimeInclusive,
        });

        this.logger.log(
          `${logPrefix}[${contactName}][Replay] 重跑 Agent 完成，耗时 ${agentResult.processingTime}ms，` +
            `tokens=${agentResult.reply.usage?.totalTokens || 'N/A'}`,
        );
      } else if (agentResult.runTurnEnd) {
        // 首次结果被最终采纳，显式触发 turn-end lifecycle（与默认路径语义对齐：fire-and-forget）。
        void agentResult.runTurnEnd().catch((err) => {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.logger.warn(`[${contactName}] turn-end lifecycle 执行失败: ${errorMessage}`);
        });
        agentResult.runTurnEnd = undefined;
      }
    }

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

    const processedMessageIds = allMessages.map((message) => message.messageId);

    // Agent 主动沉默：跳过 WeCom 发送，但仍完成本轮流水与观测。
    if (agentResult.isSkipped) {
      this.logger.log(`${logPrefix}[${contactName}] Agent 主动沉默，跳过消息发送`);
      await this.wecomObservability.markReplySkipped(traceId);
      const skippedMetadata = await this.buildSuccessMetadata(
        traceId,
        agentResult,
        { segmentCount: 0 },
        scenario,
        batchContext?.batchId,
      );
      this.monitoringService.recordSuccess(traceId, skippedMetadata);
      await this.markMessagesAsProcessed(processedMessageIds);
      return;
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
    await this.markMessagesAsProcessed(processedMessageIds);

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
    const replyPreview = agentResult.isSkipped
      ? `[主动沉默] ${this.extractSkipReason(agentResult) || '本轮无需回复'}`
      : agentResult.reply.content;
    return this.wecomObservability.buildSuccessMetadata(traceId, {
      scenario,
      batchId,
      replyPreview,
      replySegments: deliveryResult.segmentCount,
      extraResponse: {
        processingTimeMs: agentResult.processingTime,
      },
    });
  }

  private extractSkipReason(agentResult: AgentInvokeResult): string | undefined {
    const call = agentResult.toolCalls?.find((tc) => tc.toolName === 'skip_reply');
    const reason = (call?.args as { reason?: unknown } | undefined)?.reason;
    return typeof reason === 'string' && reason.trim().length > 0 ? reason.trim() : undefined;
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
    visualMessageTypes?: Record<string, MessageType.IMAGE | MessageType.EMOTION>;
    botUserId?: string;
    contactName?: string;
    botImId?: string;
    externalUserId?: string;
    token?: string;
    imContactId?: string;
    imRoomId?: string;
    apiType?: 'enterprise' | 'group';
    modelId?: string;
    thinking?: AgentThinkingConfig;
    shortTermEndTimeInclusive?: number;
    /** 延迟 turn-end 生命周期触发；replay 首次调用置 true 以便被丢弃时不污染记忆 */
    deferTurnEnd?: boolean;
  }): Promise<AgentInvokeResult> {
    const {
      userMessage,
      scenario = 'candidate-consultation',
      messageId,
      recordMonitoring = true,
      userId,
      corpId,
      deferTurnEnd,
    } = params;

    const startTime = Date.now();
    let shouldRecordAiEnd = false;

    try {
      if (recordMonitoring && messageId) {
        await this.wecomObservability.markAiStart(messageId);
        shouldRecordAiEnd = true;
      }

      const result = await this.runner.invoke({
        callerKind: CallerKind.WECOM,
        messages: [{ role: 'user', content: userMessage }],
        userId,
        corpId,
        sessionId: params.sessionId,
        messageId,
        scenario,
        contactName: params.contactName,
        imageUrls: params.imageUrls,
        imageMessageIds: params.imageMessageIds,
        visualMessageTypes: params.visualMessageTypes,
        botUserId: params.botUserId,
        botImId: params.botImId,
        externalUserId: params.externalUserId,
        token: params.token,
        imContactId: params.imContactId,
        imRoomId: params.imRoomId,
        apiType: params.apiType,
        modelId: params.modelId,
        thinking: params.thinking,
        shortTermEndTimeInclusive: params.shortTermEndTimeInclusive,
        deferTurnEnd,
        onPreparedRequest:
          recordMonitoring && messageId
            ? (agentRequest) => this.wecomObservability.recordAgentRequest(messageId, agentRequest)
            : undefined,
      });

      const processingTime = Date.now() - startTime;
      const content = this.normalizeContent(result.text);
      const isSkipped = result.toolCalls?.some((call) => call.toolName === 'skip_reply') ?? false;

      const invokeResult: AgentInvokeResult = {
        reply: { content, reasoning: result.reasoning, usage: result.usage },
        isFallback: false,
        isSkipped,
        processingTime,
        toolCalls: result.toolCalls,
        agentSteps: result.agentSteps,
        memorySnapshot: result.memorySnapshot,
        responseMessages: result.responseMessages,
        runTurnEnd: result.runTurnEnd,
      };
      if (recordMonitoring && messageId) {
        await this.wecomObservability.recordAgentResult(messageId, invokeResult);
      }

      if (!content && !isSkipped) {
        const emptyResponseError = new Error('Agent 返回空响应') as AgentError;
        emptyResponseError.isAgentError = true;
        emptyResponseError.agentMeta = {
          sessionId: params.sessionId,
          userId,
          messageCount: 1,
          lastCategory: 'empty_response',
        };
        throw emptyResponseError;
      }

      this.logger.log(
        `Agent 调用成功，耗时 ${processingTime}ms，tokens=${result.usage?.totalTokens || 'N/A'}${
          isSkipped ? '，本轮主动沉默' : ''
        }`,
      );

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

  private resolveShortTermEndTimeInclusive(
    messages: EnterpriseMessageCallbackDto[],
  ): number | undefined {
    const timestamps = messages
      .map((message) => this.resolveStoredMessageTimestamp(message))
      .filter((timestamp): timestamp is number => Number.isFinite(timestamp));
    return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
  }

  private resolveStoredMessageTimestamp(message: EnterpriseMessageCallbackDto): number | undefined {
    const callbackTimestamp = Number.parseInt(String(message.timestamp), 10);
    if (Number.isFinite(callbackTimestamp) && callbackTimestamp > 0) {
      return callbackTimestamp;
    }
    if (Number.isFinite(message._receivedAtMs) && (message._receivedAtMs ?? 0) > 0) {
      return message._receivedAtMs;
    }
    return undefined;
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

  private collectImageUrls(messages: EnterpriseMessageCallbackDto[]): string[] {
    return messages
      .map((message) => MessageParser.extractImageUrl(message))
      .filter((url): url is string => url !== null);
  }

  private collectImageMessageIds(messages: EnterpriseMessageCallbackDto[]): string[] {
    return messages
      .filter((message) => MessageParser.extractImageUrl(message) !== null)
      .map((message) => message.messageId);
  }

  /**
   * 构建 messageId → 视觉类型 映射（IMAGE / EMOTION）。
   * 供 save_image_description 工具按类型选用前缀写回 DB。
   */
  private buildVisualMessageTypes(
    messages: EnterpriseMessageCallbackDto[],
  ): Record<string, MessageType.IMAGE | MessageType.EMOTION> {
    const map: Record<string, MessageType.IMAGE | MessageType.EMOTION> = {};
    for (const message of messages) {
      const kind = MessageParser.extractVisualMessageType(message);
      if (kind) {
        map[message.messageId] = kind;
      }
    }
    return map;
  }

  /**
   * Agent 执行期间的新消息：原子取出并清空 pending list。
   *
   * 调用时机限定在 Bull Worker 持有 per-chat 处理锁期间，
   * 因此 LRANGE + LTRIM 非原子不会造成跨 Worker 的竞态。
   */
  private async fetchPendingSinceAgentStart(
    chatId: string,
  ): Promise<EnterpriseMessageCallbackDto[]> {
    try {
      const { messages } = await this.simpleMergeService.getAndClearPendingMessages(chatId);
      return messages;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[Replay] 读取 Agent 执行期间的新消息失败，跳过重跑 chatId=${chatId}: ${errorMessage}`,
      );
      return [];
    }
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
