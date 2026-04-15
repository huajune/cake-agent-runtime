import { Injectable, Logger } from '@nestjs/common';
import { supportsVision } from '@providers/types';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { OnboardFollowupMonitorService } from '@biz/recruitment-case/services/onboard-followup-monitor.service';
import { ChatMessageInput } from '@biz/message/types/message.types';
import { ConversationRiskService } from '@/conversation-risk/services/conversation-risk.service';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageRuntimeConfigService } from '../runtime/message-runtime-config.service';
import { FilterResult, MessageFilterService } from './filter.service';
import { ImageDescriptionService } from './image-description.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';

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
    private readonly conversationRiskService: ConversationRiskService,
    private readonly onboardFollowupMonitorService: OnboardFollowupMonitorService,
    private readonly runtimeConfig: MessageRuntimeConfigService,
  ) {}

  async execute(messageData: EnterpriseMessageCallbackDto): Promise<AcceptInboundMessageResult> {
    if (messageData.isSelf === true) {
      await this.handleSelfMessage(messageData);
      await this.deduplicationService.markMessageAsProcessedAsync(messageData.messageId);
      return { shouldDispatch: false, response: { success: true, message: 'Self message stored' } };
    }

    const filterResult = await this.filterService.validate(messageData);

    if (!filterResult.pass) {
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

    let historyStored = false;
    const parsed = MessageParser.parse(messageData);
    const scenario: ScenarioType = MessageParser.determineScenario();
    const requestContent = filterResult.content ?? parsed.content;

    try {
      await this.recordUserMessageToHistory(messageData, filterResult.content);
      historyStored = true;
      await this.wecomObservability.markHistoryStored(messageData.messageId);

      void this.conversationRiskService
        .checkAndHandle({
          messageData,
          content: requestContent,
        })
        .then((riskResult) => {
          if (riskResult.hit) {
            this.logger.warn(
              `[交流异常检测] 已异步暂停托管 [${messageData.messageId}], chatId=${parsed.chatId}, alerted=${riskResult.alerted}`,
            );
          }
        })
        .catch((riskError) => {
          const riskErrorMessage =
            riskError instanceof Error ? riskError.message : String(riskError);
          this.logger.error(
            `[交流异常检测] 异步检测失败 [${messageData.messageId}]: ${riskErrorMessage}`,
          );
        });

      void this.onboardFollowupMonitorService
        .checkAndHandle({
          messageData,
          content: requestContent,
        })
        .then((monitorResult) => {
          if (monitorResult.hit) {
            this.logger.warn(
              `[面试及上岗对接] 已异步暂停托管 [${messageData.messageId}], chatId=${parsed.chatId}, alerted=${monitorResult.alerted}`,
            );
          }
        })
        .catch((monitorError) => {
          const monitorErrorMessage =
            monitorError instanceof Error ? monitorError.message : String(monitorError);
          this.logger.error(
            `[面试及上岗对接] 异步检测失败 [${messageData.messageId}]: ${monitorErrorMessage}`,
          );
        });

      await this.prepareImageIfNeeded(messageData);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (!(await this.wecomObservability.hasTrace(messageData.messageId))) {
        await this.wecomObservability.startRequestTrace({
          traceId: messageData.messageId,
          primaryMessage: messageData,
          scenario,
          content: requestContent,
        });
        if (historyStored) {
          await this.wecomObservability.markHistoryStored(messageData.messageId);
        }
      }
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

  private async prepareImageIfNeeded(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const imgUrl = MessageParser.extractImageUrl(messageData);
    if (!imgUrl) {
      return;
    }

    const { effectiveModelId } = await this.runtimeConfig.resolveWecomChatModelSelection();
    const shouldDescribeBeforeAgent = !supportsVision(effectiveModelId);

    if (shouldDescribeBeforeAgent) {
      await this.imageDescription.describeAndUpdateSync(messageData.messageId, imgUrl);
      await this.wecomObservability.markImagePrepared(messageData.messageId);
    }
  }

  private async handleSelfMessage(messageData: EnterpriseMessageCallbackDto): Promise<void> {
    const parsed = MessageParser.parse(messageData);
    const { chatId, content } = parsed;

    if (!content || content.trim().length === 0) {
      this.logger.debug(`[自发消息] 消息内容为空，跳过存储 [${messageData.messageId}]`);
      return;
    }

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
  }

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
