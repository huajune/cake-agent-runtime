import { Injectable, Logger } from '@nestjs/common';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { ModelRole } from '@/llm/llm.types';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { ChatMessageInput } from '@biz/message/types/message.types';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { FilterResult, MessageFilterService } from './filter.service';
import { ImageDescriptionService } from './image-description.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';
import {
  ContactType,
  MessageSource,
  getMessageSourceDescription,
} from '@enums/message-callback.enum';
import { FilterReason } from '@enums/message-filter.enum';
import { LongTermService } from '@memory/services/long-term.service';
import type { MessageMetadata } from '@memory/types/long-term.types';

const FILTERED_HISTORY_ARCHIVE_REASONS = new Set<string>([FilterReason.INVALID_SOURCE]);

export interface AcceptInboundMessageResult {
  shouldDispatch: boolean;
  response: { success: boolean; message: string };
  content?: string;
}

@Injectable()
export class AcceptInboundMessageService {
  private readonly logger = new Logger(AcceptInboundMessageService.name);

  constructor(
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly chatSession: ChatSessionService,
    private readonly filterService: MessageFilterService,
    private readonly imageDescription: ImageDescriptionService,
    private readonly wecomObservability: WecomMessageObservabilityService,
    private readonly monitoringService: MessageTrackingService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
    private readonly llm: LlmExecutorService,
    private readonly longTerm: LongTermService,
  ) {}

  async execute(messageData: EnterpriseMessageCallbackDto): Promise<AcceptInboundMessageResult> {
    await this.initializeLongTermMemoryOnNewCustomerCallback(messageData);

    if (messageData.isSelf === true) {
      await this.handleSelfMessage(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      return { shouldDispatch: false, response: { success: true, message: 'Self message stored' } };
    }

    const filterResult = await this.filterService.validate(messageData);

    if (!filterResult.pass) {
      // pass=false is a terminal filtered path; historyOnly is only handled for pass=true below.
      await this.recordFilteredInboundMessageToHistory(messageData, filterResult);
      return {
        shouldDispatch: false,
        response: { success: true, message: `${filterResult.reason} ignored` },
      };
    }

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

    return this.prepareForDispatch(messageData, filterResult);
  }

  private async recordFilteredInboundMessageToHistory(
    messageData: EnterpriseMessageCallbackDto,
    filterResult: FilterResult,
  ): Promise<void> {
    if (!filterResult.reason || !FILTERED_HISTORY_ARCHIVE_REASONS.has(filterResult.reason)) {
      return;
    }

    const parsed = MessageParser.parse(messageData);

    if (parsed.isRoom) {
      return;
    }

    const content = filterResult.content ?? parsed.content;
    if (!content || content.trim().length === 0) {
      return;
    }

    const saved = await this.recordUserMessageToHistory(messageData, content).then(
      (inserted) => inserted,
      (error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `[过滤归档] 写入失败 [${messageData.messageId}], reason=${filterResult.reason}: ${errorMessage}`,
        );
        return false;
      },
    );

    if (saved) {
      this.logger.log(
        `[过滤归档] 已记录但不触发AI [${messageData.messageId}], chatId=${parsed.chatId}, reason=${filterResult.reason}`,
      );
    }
  }

  private async prepareForDispatch(
    messageData: EnterpriseMessageCallbackDto,
    filterResult: FilterResult,
  ): Promise<AcceptInboundMessageResult> {
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

    const parsed = MessageParser.parse(messageData);
    const scenario: ScenarioType = MessageParser.determineScenario();
    const requestContent = filterResult.content ?? parsed.content;

    // 前置打点：trace 在回调入口就建立，后续 markHistoryStored/markImagePrepared/markQueueAdd
    // 都能真实落盘，不再被静默塞进 Queue 时间里。
    if (!(await this.wecomObservability.hasTrace(messageData.messageId))) {
      await this.wecomObservability.startRequestTrace({
        traceId: messageData.messageId,
        primaryMessage: messageData,
        scenario,
        content: requestContent,
      });
    }

    // 图片消息：先同步获取原图 URL 写入 payload，再存记录（一次 INSERT 到位）
    await this.enrichImagePayload(messageData);

    // 历史记录异步化：chat_messages INSERT（Supabase）+ short-term cache（Redis）总计
    // 约 500ms-2s，阻塞了 PreDispatch。Agent 在 ≥10s 静默窗口后才读历史，
    // 异步写入有充裕时间完成。失败降级：下一轮看不到本轮 user 消息。
    void this.recordUserMessageToHistory(messageData, filterResult.content)
      .then(() => this.wecomObservability.markHistoryStored(messageData.messageId))
      .catch((error) => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.logger.warn(`[异步历史记录] 写入失败 [${messageData.messageId}]: ${errorMessage}`);
      });

    try {
      await this.prepareImageIfNeeded(messageData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const failureMetadata = await this.wecomObservability.buildFailureMetadata(
        messageData.messageId,
        {
          scenario,
          errorType: 'message',
          errorMessage,
          extraResponse: {
            phase: 'pre-dispatch',
            chatId: parsed.chatId,
          },
        },
      );
      this.monitoringService.recordFailure(messageData.messageId, errorMessage, failureMetadata);
      throw error;
    }

    return {
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
      content: filterResult.content,
    };
  }

  private async initializeLongTermMemoryOnNewCustomerCallback(
    messageData: EnterpriseMessageCallbackDto,
  ): Promise<void> {
    if (messageData.source !== MessageSource.NEW_CUSTOMER_ANSWER_SOP) return;
    if (messageData.imRoomId) return;
    if (messageData.contactType !== ContactType.PERSONAL_WECHAT) return;

    const userId = this.resolveLongTermUserId(messageData);
    if (!userId) {
      this.logger.warn(`[新好友初始化] 缺少 userId，跳过 [${messageData.messageId}]`);
      return;
    }

    const metadata = this.buildMessageMetadata(messageData);
    if (!metadata) return;

    try {
      await this.longTerm.updateMessageMetadata(messageData.orgId || 'default', userId, metadata);
      this.logger.log(
        `[新好友初始化] 已初始化长期记忆: corpId=${messageData.orgId || 'default'}, userId=${userId}`,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `[新好友初始化] 长期记忆初始化失败 [${messageData.messageId}]: ${errorMessage}`,
      );
    }
  }

  private resolveLongTermUserId(messageData: EnterpriseMessageCallbackDto): string | null {
    return messageData.imContactId || messageData.externalUserId || messageData.chatId || null;
  }

  private buildMessageMetadata(messageData: EnterpriseMessageCallbackDto): MessageMetadata | null {
    const metadata: MessageMetadata = {};
    this.assignIfPresent(metadata, 'botId', messageData.botId);
    this.assignIfPresent(metadata, 'imBotId', messageData.imBotId);
    this.assignIfPresent(metadata, 'imContactId', messageData.imContactId);
    this.assignIfPresent(metadata, 'contactType', messageData.contactType);
    this.assignIfPresent(metadata, 'contactName', messageData.contactName);
    this.assignIfPresent(metadata, 'externalUserId', messageData.externalUserId);
    this.assignIfPresent(metadata, 'avatar', messageData.avatar);
    return Object.keys(metadata).length > 0 ? metadata : null;
  }

  private assignIfPresent<K extends keyof MessageMetadata>(
    target: MessageMetadata,
    key: K,
    value: MessageMetadata[K] | undefined,
  ): void {
    if (value === null || value === undefined) return;
    if (typeof value === 'string' && value.trim().length === 0) return;
    target[key] = value;
  }

  private async prepareImageIfNeeded(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) {
      return;
    }

    const visualKind = MessageParser.extractVisualMessageType(messageData);
    if (!visualKind) {
      return;
    }

    const { overrideModelId } = await this.runtimeConfig.resolveWecomChatModelSelection();
    const shouldDescribeBeforeAgent = !this.llm.supportsVisionInput({
      role: ModelRole.Chat,
      modelId: overrideModelId,
    });

    if (!shouldDescribeBeforeAgent) {
      return;
    }

    // 关键：vision 描述同步等待会让消息晚 ~6s 才进 Redis 队列，期间前一条文本的
    // debounce 静默会"假性达标"提前 fire，把图文拆成两批（参见 wecom-batch race）。
    // 改 fire-and-forget 后，addMessage 立即更新 lastMessageAt 重置静默；worker
    // 真正取本批后由 ReplyWorkflowService 的 awaitVision 等待描述完成再调 Agent。
    const resolvedUrl = (messageData.payload as Record<string, unknown>)?.artworkUrl as
      | string
      | undefined;
    this.imageDescription.describeAndUpdateAsync(
      messageData.messageId,
      resolvedUrl || imgUrl,
      visualKind,
    );

    // 描述真正完成后再补打 imagePreparedAt（observability only），不影响业务正确性。
    void this.imageDescription
      .awaitVision([messageData.messageId], 30_000)
      .then(() => this.wecomObservability.markImagePrepared(messageData.messageId))
      .catch(() => {});
  }

  private async handleSelfMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content } = parsed;

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[自发消息] 消息内容为空，跳过存储 [${messageData.messageId}]`);
      return;
    }

    if (messageData.source === MessageSource.MOBILE_PUSH) {
      this.logger.warn(
        `[自发消息-异常来源] isSelf=true 但 source=${messageData.source}(${getMessageSourceDescription(messageData.source)}), ` +
          `messageId=${messageData.messageId}, chatId=${chatId}, botId=${messageData.botId}, botUserId=${messageData.botUserId}`,
      );
    }

    await this.enrichImagePayload(messageData);
    const candidateName = await this.getCandidateNameFromHistory(chatId);
    const isRoom = Boolean(messageData.imRoomId);
    const assistantMsg: ChatMessageInput = {
      chatId,
      messageId: messageData.messageId,
      role: 'assistant',
      content,
      timestamp: this.resolveStoredTimestamp(parsed.timestamp),
      candidateName,
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
    await this.chatSession.saveMessage(assistantMsg);

    this.logger.log(
      `[自发消息] 已存储为 assistant 历史 [${messageData.messageId}]: "${content.substring(0, 50)}${content.length > 50 ? '...' : ''}"`,
    );

    // 招募经理（真人）发的图片/表情也需要 vision 描述：assistant 角色历史不会作为
    // image part 注入下一轮 Agent，模型只能从 text content 读图。这里 fire-and-forget
    // 触发描述，描述完成后会通过 chat_messages.UPDATE 回写 content（带 [图片消息] 前缀）
    // 并失效短期记忆缓存。
    this.triggerSelfMessageVisionIfNeeded(messageData);
  }

  private triggerSelfMessageVisionIfNeeded(messageData: EnterpriseMessageCallbackDto): void {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) return;
    const visualKind = MessageParser.extractVisualMessageType(messageData);
    if (!visualKind) return;
    const resolvedUrl = (messageData.payload as Record<string, unknown>)?.artworkUrl as
      | string
      | undefined;
    this.imageDescription.describeAndUpdateAsync(
      messageData.messageId,
      resolvedUrl || imgUrl,
      visualKind,
    );
  }

  private async enrichImagePayload(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) return;

    const artworkUrl = await this.imageDescription.resolveArtworkUrl(
      messageData.messageId,
      imgUrl,
      {
        chatId: messageData.chatId,
        imBotId: messageData.imBotId,
        imContactId: messageData.imContactId,
        imRoomId: messageData.imRoomId,
      },
    );

    if (artworkUrl !== imgUrl) {
      (messageData.payload as Record<string, unknown>).artworkUrl = artworkUrl;
    }
  }

  private async recordUserMessageToHistory(
    messageData: EnterpriseMessageCallbackDto,
    contentFromFilter?: string,
  ): Promise<boolean> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, contactName } = parsed;
    const content = contentFromFilter ?? parsed.content;
    const isRoom = Boolean(messageData.imRoomId);

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[历史记录] 消息内容为空，跳过记录历史 [${messageData.messageId}]`);
      return false;
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
    return this.chatSession.saveMessage(userMsg);
  }

  private async getCandidateNameFromHistory(chatId: string): Promise<string | undefined> {
    try {
      const detail = await this.chatSession.getChatSessionMessages(chatId);
      if (!detail?.messages) {
        return undefined;
      }
      const userMessage = detail.messages.find(
        (message) => message.role === 'user' && message.candidateName,
      );
      return userMessage?.candidateName;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.debug(`获取候选人昵称失败 [${chatId}]: ${errorMessage}`);
      return undefined;
    }
  }

  private resolveStoredTimestamp(timestamp: number): number {
    return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now();
  }
}
