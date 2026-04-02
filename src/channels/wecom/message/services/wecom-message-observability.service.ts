import { Injectable, Logger } from '@nestjs/common';
import { ScenarioType } from '@enums/agent.enum';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import {
  AgentInvokeResult,
  DeliveryResult,
  AlertErrorType,
  StorageContactType,
  StorageMessageSource,
  StorageMessageType,
} from '../message.types';

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
  agentResult?: AgentInvokeResult;
  deliveryResult?: DeliveryResult;
  errorMessage?: string;
  errorType?: AlertErrorType;
  fallbackDelivery?: FallbackDeliverySummary;
}

@Injectable()
export class WecomMessageObservabilityService {
  private readonly logger = new Logger(WecomMessageObservabilityService.name);
  private readonly traces = new Map<string, WecomTraceContext>();

  constructor(private readonly trackingService: MessageTrackingService) {}

  startTrace(context: WecomTraceRequestContext): void {
    const now = Date.now();
    this.traces.set(context.messageId, {
      request: context,
      timings: { acceptedAt: now },
    });

    this.trackingService.recordMessageReceived(
      context.messageId,
      context.chatId,
      context.userId,
      context.userName,
      context.content,
      { scenario: context.scenario },
      context.managerName,
    );
  }

  hasTrace(messageId: string): boolean {
    return this.traces.has(messageId);
  }

  updateDispatch(messageId: string, dispatchMode: DispatchMode, batchId?: string): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.request.dispatchMode = dispatchMode;
    trace.request.batchId = batchId ?? trace.request.batchId;
  }

  markHistoryStored(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.timings.historyStoredAt = Date.now();
  }

  markImagePrepared(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.timings.imagePreparedAt = Date.now();
  }

  markWorkerStart(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace || trace.timings.workerStartAt) return;
    trace.timings.workerStartAt = Date.now();
    this.trackingService.recordWorkerStart(messageId);
  }

  markAiStart(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace || trace.timings.aiStartAt) return;
    trace.timings.aiStartAt = Date.now();
    this.trackingService.recordAiStart(messageId);
  }

  markAiEnd(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.timings.aiEndAt = Date.now();
    this.trackingService.recordAiEnd(messageId);
  }

  recordAgentResult(messageId: string, agentResult: AgentInvokeResult): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.agentResult = agentResult;
  }

  markDeliveryStart(messageId: string): void {
    const trace = this.traces.get(messageId);
    if (!trace || trace.timings.deliveryStartAt) return;
    trace.timings.deliveryStartAt = Date.now();
  }

  markDeliveryEnd(messageId: string, deliveryResult: DeliveryResult): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.timings.deliveryEndAt = Date.now();
    trace.deliveryResult = deliveryResult;
  }

  markFallbackStart(messageId: string, fallbackMessage: string): void {
    const trace = this.traces.get(messageId);
    if (!trace) return;
    trace.timings.fallbackStartAt = Date.now();
    trace.fallbackDelivery = {
      attempted: true,
      message: fallbackMessage,
    };
  }

  markFallbackEnd(
    messageId: string,
    result: {
      success: boolean;
      totalTime?: number;
      deliveredSegments?: number;
      failedSegments?: number;
      error?: string;
    },
  ): void {
    const trace = this.traces.get(messageId);
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
  }

  buildSuccessMetadata(
    messageId: string,
    options: {
      scenario: ScenarioType;
      isPrimary: boolean;
      batchId?: string;
      replySegments?: number;
      replyPreview?: string;
      extraResponse?: Record<string, unknown>;
    },
  ): MonitoringMetadata & { fallbackSuccess?: boolean; batchId?: string; isPrimary?: boolean } {
    const trace = this.traces.get(messageId);
    const completedAt = Date.now();
    const agentResult = trace?.agentResult;
    const tools = options.isPrimary
      ? agentResult?.toolCalls?.map((toolCall) => toolCall.toolName)
      : undefined;

    const metadata: MonitoringMetadata & {
      fallbackSuccess?: boolean;
      batchId?: string;
      isPrimary?: boolean;
    } = {
      scenario: options.scenario,
      batchId: options.batchId,
      isPrimary: options.isPrimary,
      replyPreview: options.isPrimary ? options.replyPreview : undefined,
      replySegments: options.isPrimary ? options.replySegments : undefined,
      tokenUsage: options.isPrimary ? (agentResult?.reply.usage?.totalTokens ?? 0) : undefined,
      tools,
      isFallback: options.isPrimary ? (agentResult?.isFallback ?? false) : false,
      fallbackSuccess: options.isPrimary && agentResult?.isFallback ? true : undefined,
      agentInvocation:
        options.isPrimary && trace
          ? {
              request: trace.request,
              response: {
                status: 'success',
                reply: {
                  content: agentResult?.reply.content,
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

    if (!options.isPrimary) {
      metadata.tokenUsage = undefined;
      metadata.tools = undefined;
      metadata.replyPreview = undefined;
      metadata.replySegments = undefined;
      metadata.agentInvocation = undefined;
      metadata.isFallback = false;
      metadata.fallbackSuccess = undefined;
    }

    this.cleanup(messageId);
    return metadata;
  }

  buildFailureMetadata(
    messageId: string,
    options: {
      scenario: ScenarioType;
      errorType: AlertErrorType;
      errorMessage: string;
      isPrimary: boolean;
      batchId?: string;
      extraResponse?: Record<string, unknown>;
    },
  ): MonitoringMetadata & {
    alertType?: AlertErrorType;
    fallbackSuccess?: boolean;
    batchId?: string;
    isPrimary?: boolean;
  } {
    const trace = this.traces.get(messageId);
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
      isPrimary?: boolean;
    } = {
      scenario: options.scenario,
      alertType: options.errorType,
      batchId: options.batchId,
      isPrimary: options.isPrimary,
      replyPreview: options.isPrimary ? agentResult?.reply.content : undefined,
      replySegments: options.isPrimary ? trace?.deliveryResult?.segmentCount : undefined,
      tokenUsage: options.isPrimary ? (agentResult?.reply.usage?.totalTokens ?? 0) : undefined,
      tools: options.isPrimary
        ? agentResult?.toolCalls?.map((toolCall) => toolCall.toolName)
        : undefined,
      isFallback: options.isPrimary ? (agentResult?.isFallback ?? false) : false,
      fallbackSuccess: trace?.fallbackDelivery?.success,
      agentInvocation:
        options.isPrimary && trace
          ? {
              request: trace.request,
              response: {
                status: 'failure',
                error: options.errorMessage,
                errorType: options.errorType,
                reply: {
                  content: agentResult?.reply.content,
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

    if (!options.isPrimary) {
      metadata.tokenUsage = undefined;
      metadata.tools = undefined;
      metadata.replyPreview = undefined;
      metadata.replySegments = undefined;
      metadata.agentInvocation = undefined;
      metadata.isFallback = false;
      metadata.fallbackSuccess = undefined;
    }

    this.cleanup(messageId);
    return metadata;
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

  private cleanup(messageId: string): void {
    if (this.traces.delete(messageId)) {
      this.logger.debug(`[WecomTrace] 已清理 trace [${messageId}]`);
    }
  }
}
