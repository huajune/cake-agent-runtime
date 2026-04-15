import { Injectable, Logger } from '@nestjs/common';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { EnterpriseMessageCallbackDto } from '../ingress/message-callback.dto';
import { MessageParser } from '../utils/message-parser.util';
import {
  AgentInvokeResult,
  DeliveryResult,
  AlertErrorType,
  StorageContactType,
  StorageMessageSource,
  StorageMessageType,
  toStorageContactType,
  toStorageMessageSource,
  toStorageMessageType,
} from '../types';
import { MessageTraceStoreService } from './message-trace-store.service';

type DispatchMode = 'direct' | 'merged' | 'disabled';

interface FallbackDeliverySummary {
  attempted: boolean;
  success?: boolean;
  message?: string;
  totalTime?: number;
  deliveredSegments?: number;
  failedSegments?: number;
  error?: string;
}

interface WecomTraceRequestContext {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  scenario: ScenarioType;
  content: string;
  imageCount: number;
  messageType?: StorageMessageType;
  messageSource?: StorageMessageSource;
  contactType?: StorageContactType;
  dispatchMode?: DispatchMode;
  batchId?: string;
  acceptedAt?: number;
  sourceMessageIds?: string[];
  sourceMessageCount?: number;
}

interface WecomTraceTimings {
  acceptedAt: number;
  historyStoredAt?: number;
  imagePreparedAt?: number;
  workerStartAt?: number;
  aiStartAt?: number;
  aiEndAt?: number;
  deliveryStartAt?: number;
  deliveryEndAt?: number;
  fallbackStartAt?: number;
  fallbackEndAt?: number;
  completedAt?: number;
}

interface WecomTraceContext {
  request: WecomTraceRequestContext;
  timings: WecomTraceTimings;
  agentRequest?: Record<string, unknown>;
  agentResult?: AgentInvokeResult;
  deliveryResult?: DeliveryResult;
  errorMessage?: string;
  errorType?: AlertErrorType;
  fallbackDelivery?: FallbackDeliverySummary;
}

interface StartMessageTraceParams {
  traceId: string;
  primaryMessage: EnterpriseMessageCallbackDto;
  scenario: ScenarioType;
  content: string;
  batchId?: string;
  allMessages?: EnterpriseMessageCallbackDto[];
}

@Injectable()
export class WecomMessageObservabilityService {
  private readonly logger = new Logger(WecomMessageObservabilityService.name);

  constructor(
    private readonly trackingService: MessageTrackingService,
    private readonly traceStore: MessageTraceStoreService,
  ) {}

  async startTrace(context: WecomTraceRequestContext): Promise<void> {
    const acceptedAt = context.acceptedAt ?? Date.now();
    await this.traceStore.set(context.messageId, {
      request: context,
      timings: { acceptedAt },
    });

    this.trackingService.recordMessageReceived(
      context.messageId,
      context.chatId,
      context.userId,
      context.userName,
      context.content,
      { scenario: context.scenario },
      context.managerName,
      acceptedAt,
    );
  }

  async startRequestTrace(params: StartMessageTraceParams): Promise<void> {
    const { traceId, primaryMessage, scenario, content, batchId, allMessages } = params;
    const parsed = MessageParser.parse(primaryMessage);
    const messages = allMessages ?? [primaryMessage];
    const imageCount = messages.filter((message) => MessageParser.extractImageUrl(message)).length;
    const acceptedAt = this.resolveAcceptedAt(messages);

    await this.startTrace({
      messageId: traceId,
      chatId: parsed.chatId,
      userId: parsed.imContactId,
      userName: parsed.contactName,
      managerName: parsed.managerName,
      scenario,
      content,
      imageCount,
      messageType: toStorageMessageType(primaryMessage.messageType),
      messageSource: toStorageMessageSource(primaryMessage.source),
      contactType: toStorageContactType(primaryMessage.contactType),
      batchId,
      acceptedAt,
      sourceMessageIds: messages.map((message) => message.messageId),
      sourceMessageCount: messages.length,
    });
  }

  buildMergedRequestContent(messages: EnterpriseMessageCallbackDto[]): string {
    const parts = messages
      .map((message) => MessageParser.extractContent(message)?.trim())
      .filter((content): content is string => Boolean(content));

    if (parts.length === 0) {
      return '[聚合消息]';
    }

    if (parts.length === 1) {
      return parts[0];
    }

    return parts.join('\n');
  }

  async hasTrace(messageId: string): Promise<boolean> {
    return Boolean(await this.traceStore.get(messageId));
  }

  async updateDispatch(
    messageId: string,
    dispatchMode: DispatchMode,
    batchId?: string,
  ): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.request.dispatchMode = dispatchMode;
    trace.request.batchId = batchId ?? trace.request.batchId;
    await this.traceStore.set(messageId, trace);
  }

  async markHistoryStored(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.historyStoredAt = Date.now();
    await this.traceStore.set(messageId, trace);
  }

  async markImagePrepared(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.imagePreparedAt = Date.now();
    await this.traceStore.set(messageId, trace);
  }

  async markWorkerStart(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace || trace.timings.workerStartAt) return;
    trace.timings.workerStartAt = Date.now();
    await this.traceStore.set(messageId, trace);
    this.trackingService.recordWorkerStart(messageId);
  }

  async markAiStart(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace || trace.timings.aiStartAt) return;
    trace.timings.aiStartAt = Date.now();
    await this.traceStore.set(messageId, trace);
    this.trackingService.recordAiStart(messageId);
  }

  async markAiEnd(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.aiEndAt = Date.now();
    await this.traceStore.set(messageId, trace);
    this.trackingService.recordAiEnd(messageId);
  }

  async recordAgentResult(messageId: string, agentResult: AgentInvokeResult): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.agentResult = agentResult;
    await this.traceStore.set(messageId, trace);
  }

  async recordAgentRequest(messageId: string, request: Record<string, unknown>): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.agentRequest = request;
    await this.traceStore.set(messageId, trace);
  }

  async markDeliveryStart(messageId: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace || trace.timings.deliveryStartAt) return;
    trace.timings.deliveryStartAt = Date.now();
    await this.traceStore.set(messageId, trace);
  }

  async markDeliveryEnd(messageId: string, deliveryResult: DeliveryResult): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.deliveryEndAt = Date.now();
    trace.deliveryResult = deliveryResult;
    await this.traceStore.set(messageId, trace);
  }

  async markFallbackStart(messageId: string, fallbackMessage: string): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.fallbackStartAt = Date.now();
    trace.fallbackDelivery = {
      attempted: true,
      message: fallbackMessage,
    };
    await this.traceStore.set(messageId, trace);
  }

  async markFallbackEnd(
    messageId: string,
    result: {
      success: boolean;
      totalTime?: number;
      deliveredSegments?: number;
      failedSegments?: number;
      error?: string;
    },
  ): Promise<void> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    if (!trace) return;
    trace.timings.fallbackEndAt = Date.now();
    trace.fallbackDelivery = {
      attempted: true,
      message: trace.fallbackDelivery?.message,
      success: result.success,
      totalTime: result.totalTime,
      deliveredSegments: result.deliveredSegments,
      failedSegments: result.failedSegments,
      error: result.error,
    };
    await this.traceStore.set(messageId, trace);
  }

  async buildSuccessMetadata(
    messageId: string,
    options: {
      scenario: ScenarioType;
      batchId?: string;
      replySegments?: number;
      replyPreview?: string;
      extraResponse?: Record<string, unknown>;
    },
  ): Promise<MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string }> {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    const completedAt = Date.now();
    const agentResult = trace?.agentResult;
    const tools = agentResult?.toolCalls?.map((toolCall) => toolCall.toolName);

    const metadata: MonitoringMetadata & {
      fallbackSuccess?: boolean;
      batchId?: string;
    } = {
      scenario: options.scenario,
      batchId: options.batchId,
      replyPreview: options.replyPreview,
      replySegments: options.replySegments,
      tokenUsage: agentResult?.reply.usage?.totalTokens ?? 0,
      tools,
      isFallback: agentResult?.isFallback ?? false,
      fallbackSuccess: agentResult?.isFallback ? true : undefined,
      agentInvocation: trace
        ? {
            request: {
              ...trace.request,
              agentRequest: trace.agentRequest,
            },
            response: {
              status: 'success',
              reply: {
                content: agentResult?.reply.content,
                reasoning: agentResult?.reply.reasoning,
                usage: agentResult?.reply.usage,
              },
              toolCalls: agentResult?.toolCalls,
              delivery: trace.deliveryResult,
              fallback: trace.fallbackDelivery,
              timings: this.buildTimingSummary(trace, completedAt),
              ...options.extraResponse,
            },
            isFallback: agentResult?.isFallback ?? false,
          }
        : undefined,
    };

    await this.cleanup(messageId);
    return metadata;
  }

  async buildFailureMetadata(
    messageId: string,
    options: {
      scenario: ScenarioType;
      errorType: AlertErrorType;
      errorMessage: string;
      batchId?: string;
      extraResponse?: Record<string, unknown>;
    },
  ): Promise<
    MonitoringMetadata & {
      alertType?: AlertErrorType;
      fallbackSuccess?: boolean;
      batchId?: string;
    }
  > {
    const trace = await this.traceStore.get<WecomTraceContext>(messageId);
    const completedAt = Date.now();

    if (trace) {
      trace.errorMessage = options.errorMessage;
      trace.errorType = options.errorType;
    }

    const agentResult = trace?.agentResult;
    const metadata: MonitoringMetadata & {
      alertType?: AlertErrorType;
      fallbackSuccess?: boolean;
      batchId?: string;
    } = {
      scenario: options.scenario,
      alertType: options.errorType,
      batchId: options.batchId,
      replyPreview: agentResult?.reply.content,
      replySegments: trace?.deliveryResult?.segmentCount,
      tokenUsage: agentResult?.reply.usage?.totalTokens ?? 0,
      tools: agentResult?.toolCalls?.map((toolCall) => toolCall.toolName),
      isFallback: agentResult?.isFallback ?? Boolean(trace?.fallbackDelivery),
      fallbackSuccess: trace?.fallbackDelivery?.success,
      agentInvocation: trace
        ? {
            request: {
              ...trace.request,
              agentRequest: trace.agentRequest,
            },
            response: {
              status: 'failure',
              error: options.errorMessage,
              errorType: options.errorType,
              reply: {
                content: agentResult?.reply.content,
                reasoning: agentResult?.reply.reasoning,
                usage: agentResult?.reply.usage,
              },
              toolCalls: agentResult?.toolCalls,
              delivery: trace.deliveryResult,
              fallback: trace.fallbackDelivery,
              timings: this.buildTimingSummary(trace, completedAt),
              ...options.extraResponse,
            },
            isFallback: agentResult?.isFallback ?? Boolean(trace.fallbackDelivery),
          }
        : undefined,
    };

    await this.cleanup(messageId);
    return metadata;
  }

  private resolveAcceptedAt(messages: EnterpriseMessageCallbackDto[]): number {
    const candidates = messages
      .map((message) => message._receivedAtMs)
      .filter((value): value is number => Number.isFinite(value) && value > 0);

    if (candidates.length === 0) {
      return Date.now();
    }

    return Math.min(...candidates);
  }

  private buildTimingSummary(trace: WecomTraceContext, completedAt: number) {
    const timings = {
      ...trace.timings,
      completedAt,
    };

    return {
      timestamps: timings,
      durations: {
        acceptedToHistoryStoredMs: this.diff(timings.historyStoredAt, timings.acceptedAt),
        acceptedToImagePreparedMs: this.diff(timings.imagePreparedAt, timings.acceptedAt),
        acceptedToWorkerStartMs: this.diff(timings.workerStartAt, timings.acceptedAt),
        acceptedToAiStartMs: this.diff(timings.aiStartAt, timings.acceptedAt),
        acceptedToAiEndMs: this.diff(timings.aiEndAt, timings.acceptedAt),
        acceptedToDeliveryStartMs: this.diff(timings.deliveryStartAt, timings.acceptedAt),
        acceptedToDeliveryEndMs: this.diff(timings.deliveryEndAt, timings.acceptedAt),
        workerStartToAiStartMs: this.diff(timings.aiStartAt, timings.workerStartAt),
        aiStartToAiEndMs: this.diff(timings.aiEndAt, timings.aiStartAt),
        aiEndToDeliveryStartMs: this.diff(timings.deliveryStartAt, timings.aiEndAt),
        deliveryDurationMs: this.diff(timings.deliveryEndAt, timings.deliveryStartAt),
        fallbackDurationMs: this.diff(timings.fallbackEndAt, timings.fallbackStartAt),
        totalMs: this.diff(completedAt, timings.acceptedAt) ?? 0,
      },
    };
  }

  private diff(to?: number, from?: number): number | undefined {
    if (to === undefined || from === undefined) return undefined;
    return Math.max(to - from, 0);
  }

  private async cleanup(messageId: string): Promise<void> {
    await this.traceStore.delete(messageId);
    this.logger.debug(`[WecomTrace] 已清理 trace [${messageId}]`);
  }
}
