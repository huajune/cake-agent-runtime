import { Logger } from '@nestjs/common';
import type { UIMessageChunk } from 'ai';
import { randomUUID } from 'node:crypto';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { Observer } from '@observability/observer.interface';
import { MonitoringMetadata } from '@shared-types/tracking.types';
import { computeResultCount, computeToolCallStatus } from '@agent/tool-call-analysis';
import { AiStreamTraceContentStore } from './ai-stream-trace-content-store';
import { AiStreamTraceTiming } from './ai-stream-trace-timing';

const DEFAULT_SCENARIO = 'candidate-consultation';

export interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface AiStreamTraceMarks {
  receivedAt: number;
  workerStartAt?: number;
  aiStartAt?: number;
  streamReadyAt?: number;
  responsePipeStartAt?: number;
  firstChunkAt?: number;
  firstReasoningStartAt?: number;
  firstReasoningDeltaAt?: number;
  firstTextStartAt?: number;
  firstTextDeltaAt?: number;
  finishChunkAt?: number;
  usageResolvedAt?: number;
  completedAt?: number;
}

export interface AiStreamTraceOptions {
  chatId: string;
  userId?: string;
  scenario?: string;
  messageText?: string;
  requestBody: Record<string, unknown>;
  /**
   * 数据归属。`testing` 源的 trace 不会写入生产观测表（message_processing_records、
   * user_activity、Redis 计数器），避免污染"今日托管"等生产看板；省略等同 `production`。
   */
  source?: 'production' | 'testing';
}

export interface AiStreamTimingPayload {
  timestamps: AiStreamTraceMarks;
  durations: {
    totalMs: number;
    requestToAiStartMs?: number;
    requestToStreamReadyMs?: number;
    requestToResponsePipeStartMs?: number;
    requestToFirstChunkMs?: number;
    requestToFirstReasoningStartMs?: number;
    requestToFirstReasoningDeltaMs?: number;
    requestToFirstTextStartMs?: number;
    requestToFirstTextDeltaMs?: number;
    aiStartToStreamReadyMs?: number;
    streamReadyToResponsePipeStartMs?: number;
    responsePipeStartToFirstChunkMs?: number;
    firstChunkToFinishMs?: number;
    responsePipeStartToFinishMs?: number;
    requestToUsageResolvedMs?: number;
  };
}

export type ContentKind = 'text' | 'reasoning' | 'tool';

export interface ContentOrderItem {
  kind: ContentKind;
  id: string;
}

export type ToolCallState =
  | 'input-streaming'
  | 'input-available'
  | 'input-error'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

export interface CapturedToolCall {
  toolCallId: string;
  toolName?: string;
  input?: unknown;
  inputTextParts: string[];
  output?: unknown;
  errorText?: string;
  state: ToolCallState;
  providerExecuted?: boolean;
  dynamic?: boolean;
  title?: string;
  preliminary?: boolean;
}

export interface StoredToolCall {
  toolCallId: string;
  toolName: string;
  input?: unknown;
  inputText?: string;
  output?: unknown;
  errorText?: string;
  state: ToolCallState;
  providerExecuted?: boolean;
  dynamic?: boolean;
  title?: string;
  preliminary?: boolean;
}

export interface StoredUiMessagePart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  state?: 'input-available' | 'output-available' | 'output-error';
  errorText?: string;
}

export interface StoredUiMessage {
  id: string;
  role: 'assistant';
  parts: StoredUiMessagePart[];
}

export interface StoredReplyPayload {
  content?: string;
  reasoning?: string;
  usage?: StreamUsage;
}

export interface StoredAiStreamResponse extends AiStreamSummaryPayload {
  reply?: StoredReplyPayload;
  toolCalls?: StoredToolCall[];
  messages?: StoredUiMessage[];
}

export interface AiStreamSummaryPayload {
  traceId: string;
  sessionId: string;
  scenario: string;
  status: 'success' | 'failure';
  entryStage: string | null;
  firstChunkType?: string;
  finishReason?: string;
  error?: string;
  usage?: StreamUsage;
  chunkTypeCounts: Record<string, number>;
  stepCount: number;
  tools: string[];
  hasReasoning: boolean;
  hasText: boolean;
  replyPreview?: string;
  reasoningPreview?: string;
  timings: AiStreamTimingPayload;
}

export class AiStreamTrace {
  private readonly logger = new Logger(AiStreamTrace.name);
  private readonly traceId: string;
  private readonly scenario: string;
  private readonly timing = new AiStreamTraceTiming();
  private readonly content = new AiStreamTraceContentStore();
  /** true 时跳过生产观测表写入（只保留 observer 事件与 SSE 元数据）。 */
  private readonly skipTrackingPersistence: boolean;

  private requestBody: Record<string, unknown>;
  private usage?: StreamUsage;
  private entryStage: string | null = null;
  private finalized = false;

  constructor(
    private readonly messageTrackingService: MessageTrackingService,
    private readonly observer: Observer,
    private readonly options: AiStreamTraceOptions,
  ) {
    this.traceId = `ai-stream:${options.chatId}:${randomUUID()}`;
    this.scenario = options.scenario || DEFAULT_SCENARIO;
    this.requestBody = options.requestBody;
    this.skipTrackingPersistence = options.source === 'testing';

    if (!this.skipTrackingPersistence) {
      this.messageTrackingService.recordMessageReceived(
        this.traceId,
        options.chatId,
        options.userId,
        options.userId,
        options.messageText,
        {
          scenario: this.scenario as MonitoringMetadata['scenario'],
        },
      );

      this.messageTrackingService.recordWorkerStart(this.traceId);
    }
    this.timing.markWorkerStart();

    this.observer.emit({
      type: 'agent_start',
      userId: options.userId || 'unknown',
      corpId: 'test',
      scenario: this.scenario,
    });
  }

  get messageId(): string {
    return this.traceId;
  }

  mergeRequestBody(partial: Record<string, unknown>): void {
    this.requestBody = {
      ...this.requestBody,
      ...partial,
    };
  }

  markAiStart(): void {
    if (!this.timing.markAiStart()) return;
    if (!this.skipTrackingPersistence) {
      this.messageTrackingService.recordAiStart(this.traceId);
    }
  }

  markStreamReady(entryStage: string | null): void {
    this.entryStage = entryStage;
    this.timing.markStreamReady();
  }

  markResponsePipeStart(): void {
    if (!this.timing.markResponsePipeStart()) return;
    if (!this.skipTrackingPersistence) {
      this.messageTrackingService.recordSendStart(this.traceId);
    }
  }

  observeChunk(chunk: UIMessageChunk): void {
    if (this.content.recordChunkType(chunk.type)) {
      this.timing.markFirstChunk();
    }

    switch (chunk.type) {
      case 'reasoning-start':
        this.timing.markFirstReasoningStart();
        this.content.startReasoningBlock(chunk.id);
        break;
      case 'reasoning-delta':
        this.timing.markFirstReasoningDelta();
        this.content.appendReasoningDelta(chunk.id, chunk.delta);
        break;
      case 'text-start':
        this.timing.markFirstTextStart();
        this.content.startTextBlock(chunk.id);
        break;
      case 'text-delta':
        this.timing.markFirstTextDelta();
        this.content.appendTextDelta(chunk.id, chunk.delta);
        break;
      case 'tool-input-start':
        this.content.beginToolInput(chunk.toolCallId, {
          toolName: chunk.toolName,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
        });
        break;
      case 'tool-input-delta':
        this.content.appendToolInputDelta(chunk.toolCallId, chunk.inputTextDelta);
        break;
      case 'tool-input-available':
        this.content.setToolInputAvailable(chunk.toolCallId, {
          toolName: chunk.toolName,
          input: chunk.input,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
        });
        break;
      case 'tool-input-error':
        this.content.setToolInputError(chunk.toolCallId, {
          toolName: chunk.toolName,
          input: chunk.input,
          errorText: chunk.errorText,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
        });
        break;
      case 'tool-output-available':
        this.content.setToolOutputAvailable(chunk.toolCallId, {
          output: chunk.output,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          preliminary: chunk.preliminary,
        });
        break;
      case 'tool-output-error':
        this.content.setToolOutputError(chunk.toolCallId, {
          errorText: chunk.errorText,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
        });
        break;
      case 'tool-output-denied':
        this.content.setToolOutputDenied(chunk.toolCallId);
        break;
      case 'start-step':
        this.content.incrementStepCount();
        break;
      case 'finish':
        this.content.markFinish(chunk.finishReason);
        this.timing.markFinishChunk();
        break;
      case 'error':
        this.content.markError(chunk.errorText);
        break;
      default:
        break;
    }
  }

  recordUsage(usage: StreamUsage): void {
    this.usage = usage;
    this.timing.markUsageResolved();
  }

  hasStreamError(): boolean {
    return this.content.hasStreamError();
  }

  getStreamErrorMessage(): string | undefined {
    return this.content.getStreamErrorMessage();
  }

  getClientPayload(status: 'success' | 'failure', error?: string): AiStreamSummaryPayload {
    const completedAt = this.timing.marks.completedAt ?? Date.now();
    const timings = this.timing.buildTimings(completedAt);

    return {
      traceId: this.traceId,
      sessionId: this.options.chatId,
      scenario: this.scenario,
      status,
      entryStage: this.entryStage,
      firstChunkType: this.content.getFirstChunkType(),
      finishReason: this.content.getFinishReason(),
      error,
      usage: this.usage,
      chunkTypeCounts: this.content.getChunkTypeCounts(),
      stepCount: this.content.getStepCount(),
      tools: this.content.getTools(),
      hasReasoning: this.content.hasReasoning(),
      hasText: this.content.hasText(),
      replyPreview: this.content.getReplyPreview(),
      reasoningPreview: this.content.getReasoningPreview(),
      timings,
    };
  }

  finalizeSuccess(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.completeLifecycle();

    const payload = this.getClientPayload('success');
    const metadata = this.buildMonitoringMetadata(payload);

    if (!this.skipTrackingPersistence) {
      this.messageTrackingService.recordSuccess(this.traceId, metadata);
    }
    this.emitObserverSummary(payload);

    this.logger.log(
      `[AI-Stream][${this.traceId}] total=${payload.timings.durations.totalMs}ms, ` +
        `streamReady=${payload.timings.durations.requestToStreamReadyMs ?? -1}ms, ` +
        `firstChunk=${payload.timings.durations.requestToFirstChunkMs ?? -1}ms, ` +
        `firstReasoning=${payload.timings.durations.requestToFirstReasoningDeltaMs ?? -1}ms, ` +
        `firstText=${payload.timings.durations.requestToFirstTextDeltaMs ?? -1}ms`,
    );
  }

  finalizeFailure(error: unknown): void {
    if (this.finalized) return;
    this.finalized = true;
    this.completeLifecycle();

    const errorMessage = this.toErrorMessage(error);
    const payload = this.getClientPayload('failure', errorMessage);
    const metadata = this.buildMonitoringMetadata(payload, errorMessage);

    if (!this.skipTrackingPersistence) {
      this.messageTrackingService.recordFailure(this.traceId, errorMessage, metadata);
    }
    this.observer.emit({
      type: 'agent_error',
      userId: this.options.userId || 'unknown',
      error: errorMessage,
    });
    this.emitObserverSummary(payload);
  }

  private buildMonitoringMetadata(
    payload: AiStreamSummaryPayload,
    errorMessage?: string,
  ): MonitoringMetadata {
    const storedResponse = this.content.buildStoredResponse(payload, this.traceId, errorMessage);
    const toolCalls = this.toAgentToolCalls(storedResponse.toolCalls);

    return {
      scenario: this.scenario as MonitoringMetadata['scenario'],
      toolCalls: toolCalls && toolCalls.length > 0 ? toolCalls : undefined,
      tokenUsage: payload.usage?.totalTokens ?? 0,
      replyPreview: storedResponse.reply?.content || payload.replyPreview,
      // Test-suite streams are rendered as a single assistant reply, not real delivery segments.
      replySegments: payload.hasText ? 1 : undefined,
      isFallback: false,
      agentInvocation: {
        request: this.requestBody,
        response: storedResponse,
        isFallback: false,
      },
    };
  }

  /**
   * 把 stream 路径捕获的 StoredToolCall 转成 AgentToolCall，供 tracking 层落入 tool_calls jsonb。
   *
   * stream 路径没有 generateText steps 那样精细的 per-step 时序，durationMs 留空；
   * resultCount/status 仍按 output 推断，用于异常标签计算。
   */
  private toAgentToolCalls(
    stored: StoredToolCall[] | undefined,
  ): MonitoringMetadata['toolCalls'] | undefined {
    if (!stored || stored.length === 0) return undefined;
    return stored
      .filter((tool) => Boolean(tool.toolName))
      .map((tool) => {
        const resultCount = computeResultCount(tool.output);
        return {
          toolName: tool.toolName,
          args: (tool.input ?? {}) as Record<string, unknown>,
          result: tool.output,
          resultCount,
          status: computeToolCallStatus(tool.output, resultCount, tool.errorText, tool.state),
        };
      });
  }

  private emitObserverSummary(payload: AiStreamSummaryPayload): void {
    this.observer.emit({
      type: 'agent_stream_timing',
      messageId: payload.traceId,
      sessionId: payload.sessionId,
      userId: this.options.userId,
      scenario: payload.scenario,
      status: payload.status,
      timeToStreamReadyMs: payload.timings.durations.requestToStreamReadyMs,
      timeToFirstChunkMs: payload.timings.durations.requestToFirstChunkMs,
      timeToFirstReasoningMs: payload.timings.durations.requestToFirstReasoningDeltaMs,
      timeToFirstTextMs: payload.timings.durations.requestToFirstTextDeltaMs,
      streamDurationMs: payload.timings.durations.firstChunkToFinishMs,
      totalDurationMs: payload.timings.durations.totalMs,
      totalTokens: payload.usage?.totalTokens,
      error: payload.error,
    });

    if (payload.status === 'success') {
      this.observer.emit({
        type: 'agent_end',
        userId: this.options.userId || 'unknown',
        steps: this.content.getStepCount(),
        totalTokens: payload.usage?.totalTokens ?? 0,
        durationMs: payload.timings.durations.totalMs,
      });
    }
  }

  private completeLifecycle(): void {
    this.timing.markCompleted();

    if (this.skipTrackingPersistence) return;

    if (this.timing.marks.aiStartAt) {
      this.messageTrackingService.recordAiEnd(this.traceId);
    }
    if (this.timing.marks.responsePipeStartAt) {
      this.messageTrackingService.recordSendEnd(this.traceId);
    }
  }

  private toErrorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return 'Unknown ai-stream error';
  }
}
