import { Injectable, Logger, HttpException, HttpStatus } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { AlertLevel } from '@infra/feishu/interfaces/interface';
import { BOT_TO_RECEIVER } from '@infra/feishu/constants/receivers';
import { maskApiKey } from '@infra/utils/string.util';
import { ScenarioType } from '@enums/agent.enum';
import { MessageDeduplicationService } from '../runtime/deduplication.service';
import { MessageDeliveryService } from '../delivery/delivery.service';
import { WecomMessageObservabilityService } from '../telemetry/wecom-message-observability.service';
import { MessageParser } from '../utils/message-parser.util';
import {
  DeliveryContext,
  AlertErrorType,
  FallbackMessageOptions,
  DeliveryFailureError,
} from '../types';
import type { AgentError } from '@shared-types/agent-error.types';

@Injectable()
export class MessageProcessingFailureService {
  private readonly logger = new Logger(MessageProcessingFailureService.name);

  private readonly defaultFallbackMessages: string[] = [
    '我确认下哈，马上回你~',
    '我这边查一下，稍等~',
    '让我看看哈，很快~',
    '这块我再核实下，确认好马上告诉你哈~',
    '这个涉及几个细节，我确认下再回你',
    '这块资料我这边暂时没看到，我先帮你记下来，确认好回你~',
  ];

  constructor(
    private readonly configService: ConfigService,
    private readonly deduplicationService: MessageDeduplicationService,
    private readonly deliveryService: MessageDeliveryService,
    private readonly monitoringService: MessageTrackingService,
    private readonly alertService: AlertNotifierService,
    private readonly wecomObservability: WecomMessageObservabilityService,
  ) {}

  inferErrorType(error: unknown, defaultErrorType: 'message' | 'merge'): AlertErrorType {
    if (this.isAgentError(error)) {
      return 'agent';
    }

    if (this.isDeliveryError(error)) {
      return 'delivery';
    }

    return defaultErrorType;
  }

  async handleProcessingError(
    error: unknown,
    parsed: ReturnType<typeof MessageParser.parse>,
    options?: {
      errorType?: AlertErrorType;
      scenario?: ScenarioType;
      traceId?: string;
      batchId?: string;
      dispatchMode?: 'direct' | 'merged';
      processedMessageIds?: string[];
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
    const traceId = options?.traceId ?? messageId;
    const processedMessageIds = options?.processedMessageIds ?? [messageId];
    const errorMessage = error instanceof Error ? error.message : String(error);
    const deliveryError = this.isDeliveryError(error) ? error : null;
    const alertCode = errorType === 'agent' ? 'agent.invoke_failed' : 'message.processing_failed';

    this.logger.error(`[${contactName}] 请求处理失败 [${traceId}]: ${errorMessage}`);

    const fallbackMessage = this.getFallbackMessage();
    const alertLevel = this.getAlertLevelFromError(error);

    const agentError = error as AgentError | null;
    const agentMeta = agentError?.agentMeta;
    const apiKey = agentError?.apiKey;
    const maskedApiKey = maskApiKey(apiKey);
    const diagnosticPayload: Record<string, unknown> = {};
    if (maskedApiKey) diagnosticPayload.apiKey = maskedApiKey;

    const errorReceiver = imBotId ? BOT_TO_RECEIVER[imBotId] : undefined;

    if (!deliveryError) {
      this.alertService
        .sendAlert({
          code: alertCode,
          severity: alertLevel,
          source: {
            subsystem: 'wecom',
            component: 'MessagePipelineService',
            action: 'handleProcessingFailure',
            trigger: 'http',
          },
          scope: {
            scenario,
            contactName,
            managerName: parsed.managerName,
            chatId,
            sessionId: agentMeta?.sessionId,
            messageId: traceId,
            batchId: options?.batchId,
            userId: imContactId,
            corpId: parsed.orgId,
          },
          impact: {
            userMessage: content,
            fallbackMessage,
            userVisible: true,
            deliveryState: 'fallback_sent',
            requiresHumanIntervention: true,
          },
          diagnostics: {
            error: error instanceof Error ? error : new Error(errorMessage),
            category: agentMeta?.lastCategory,
            modelChain: agentMeta?.modelsAttempted,
            totalAttempts: agentMeta?.totalAttempts,
            messageCount: agentMeta?.messageCount,
            memoryWarning: agentMeta?.memoryLoadWarning,
            dispatchMode: options?.dispatchMode,
            payload: Object.keys(diagnosticPayload).length > 0 ? diagnosticPayload : undefined,
          },
          routing: errorReceiver ? { atUsers: [errorReceiver] } : undefined,
          dedupe: {
            key: `${alertCode}:${scenario}`,
          },
        })
        .catch((alertError) => {
          const alertErrorMessage =
            alertError instanceof Error ? alertError.message : String(alertError);
          this.logger.error(`告警发送失败: ${alertErrorMessage}`);
        });
    }

    if ((deliveryError?.result.deliveredSegments ?? 0) > 0) {
      this.logger.warn(`[${contactName}] 回复已部分发送，跳过降级回复 [${traceId}]`);
      const failureMetadata = await this.wecomObservability.buildFailureMetadata(traceId, {
        scenario,
        errorType,
        errorMessage,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'delivery-partial',
          dispatchMode: options?.dispatchMode,
          delivery: deliveryError?.result,
        },
      });
      this.monitoringService.recordFailure(traceId, errorMessage, failureMetadata);
      await this.markMessagesAsProcessed(processedMessageIds);
      return;
    }

    try {
      const deliveryContext: DeliveryContext = {
        token,
        imBotId,
        imContactId,
        imRoomId,
        contactName,
        messageId: traceId,
        chatId,
        _apiType,
      };

      await this.wecomObservability.markFallbackStart(traceId, fallbackMessage);
      await this.deliveryService.deliverReply({ content: fallbackMessage }, deliveryContext, false);
      await this.wecomObservability.markFallbackEnd(traceId, {
        success: true,
        deliveredSegments: 1,
        failedSegments: 0,
      });

      this.logger.log(`[${contactName}] 已发送降级回复: "${fallbackMessage}"`);
      await this.markMessagesAsProcessed(processedMessageIds);

      const failureMetadata = await this.wecomObservability.buildFailureMetadata(traceId, {
        scenario,
        errorType,
        errorMessage,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'fallback-delivered',
          dispatchMode: options?.dispatchMode,
        },
      });
      this.monitoringService.recordFailure(traceId, errorMessage, failureMetadata);
    } catch (sendError) {
      const sendErrorMessage = sendError instanceof Error ? sendError.message : String(sendError);
      const deliveryFailure = this.isDeliveryError(sendError) ? sendError.result : undefined;
      await this.wecomObservability.markFallbackEnd(traceId, {
        success: false,
        totalTime: deliveryFailure?.totalTime,
        deliveredSegments: deliveryFailure?.deliveredSegments,
        failedSegments: deliveryFailure?.failedSegments,
        error: sendErrorMessage,
      });
      this.logger.error(`[${contactName}] 发送降级回复失败: ${sendErrorMessage}`);

      this.alertService
        .sendAlert({
          code: 'message.delivery_failed',
          summary: '消息发送失败 - 用户无响应',
          severity: AlertLevel.CRITICAL,
          source: {
            subsystem: 'wecom',
            component: 'MessagePipelineService',
            action: 'deliverFallbackReply',
            trigger: 'http',
          },
          scope: {
            scenario,
            contactName,
            managerName: parsed.managerName,
            chatId,
            messageId: traceId,
            batchId: options?.batchId,
            userId: imContactId,
            corpId: parsed.orgId,
          },
          impact: {
            userMessage: content,
            fallbackMessage,
            userVisible: false,
            deliveryState: 'failed',
            requiresHumanIntervention: true,
          },
          diagnostics: {
            error: sendError instanceof Error ? sendError : new Error(sendErrorMessage),
            payload: {
              originalError: errorMessage,
            },
          },
          dedupe: {
            key: `message.delivery_failed:${scenario}`,
          },
        })
        .catch((alertError) => {
          const alertErrorMessage =
            alertError instanceof Error ? alertError.message : String(alertError);
          this.logger.error(`CRITICAL 告警发送失败: ${alertErrorMessage}`);
        });

      const failureMetadata = await this.wecomObservability.buildFailureMetadata(traceId, {
        scenario,
        errorType,
        errorMessage,
        batchId: options?.batchId,
        extraResponse: {
          phase: 'fallback-failed',
          fallbackSendError: sendErrorMessage,
          dispatchMode: options?.dispatchMode,
        },
      });
      this.monitoringService.recordFailure(traceId, errorMessage, failureMetadata);
      await this.markMessagesAsProcessed(processedMessageIds);
    }
  }

  sendFallbackAlert(params: {
    contactName: string;
    botUserName?: string;
    userMessage: string;
    fallbackMessage: string;
    fallbackReason: string;
    scenario: ScenarioType;
    chatId: string;
    imBotId?: string;
  }): void {
    const {
      contactName,
      botUserName,
      userMessage,
      fallbackMessage,
      fallbackReason,
      scenario,
      chatId,
      imBotId,
    } =
      params;

    this.logger.warn(`[${contactName}] Agent 降级响应，原因: ${fallbackReason}，需要人工介入`);

    const receiver = imBotId ? BOT_TO_RECEIVER[imBotId] : undefined;

    this.alertService
      .sendAlert({
        code: 'agent.fallback_required',
        summary: '需要人工介入',
        severity: AlertLevel.WARNING,
        source: {
          subsystem: 'wecom',
          component: 'MessagePipelineService',
          action: 'sendFallbackAlert',
          trigger: 'http',
        },
        scope: {
          scenario,
          contactName,
          managerName: botUserName,
          chatId,
        },
        impact: {
          userMessage,
          fallbackMessage,
          userVisible: true,
          deliveryState: 'fallback_sent',
          requiresHumanIntervention: true,
        },
        diagnostics: {
          error: new Error(fallbackReason),
        },
        routing: receiver ? { atUsers: [receiver] } : { atAll: true },
        dedupe: {
          key: `agent.fallback_required:${scenario}`,
        },
      })
      .catch((alertError) => {
        const alertErrorMessage =
          alertError instanceof Error ? alertError.message : String(alertError);
        this.logger.error(`降级告警发送失败: ${alertErrorMessage}`);
      });
  }

  private getFallbackMessage(options?: FallbackMessageOptions): string {
    if (options?.customMessage) return options.customMessage;

    const envMessage = this.configService.get<string>('AGENT_FALLBACK_MESSAGE', '');
    if (envMessage) return envMessage;

    if (options?.random === false) return this.defaultFallbackMessages[0];

    const index = Math.floor(Math.random() * this.defaultFallbackMessages.length);
    return this.defaultFallbackMessages[index];
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

  private isAgentError(error: unknown): boolean {
    const agentError = error as AgentError | null;
    return Boolean(agentError?.isAgentError || agentError?.agentMeta);
  }

  private isDeliveryError(error: unknown): error is DeliveryFailureError {
    return error instanceof DeliveryFailureError;
  }

  private getAlertLevelFromError(error: unknown): AlertLevel {
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === HttpStatus.TOO_MANY_REQUESTS) return AlertLevel.WARNING;
    }
    if ((error as AgentError | null)?.agentMeta?.lastCategory === 'rate_limited') {
      return AlertLevel.WARNING;
    }
    return AlertLevel.ERROR;
  }
}
