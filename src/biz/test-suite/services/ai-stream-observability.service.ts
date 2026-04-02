import { Inject, Injectable, Logger } from '@nestjs/common';
import { UIMessageChunk } from 'ai';
import { randomUUID } from 'node:crypto';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { OBSERVER, Observer } from '@observability/observer.interface';
import { MonitoringMetadata } from '@shared-types/tracking.types';

const DEFAULT_SCENARIO = 'candidate-consultation';
const PREVIEW_LIMIT = 500;

interface StreamUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface AiStreamTraceMarks {
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

interface AiStreamTraceOptions {
  chatId: string;
  userId?: string;
  scenario?: string;
  messageText?: string;
  requestBody: Record<string, unknown>;
}

interface AiStreamTimingPayload {
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

interface AiStreamSummaryPayload {
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

@Injectable()
export class AiStreamObservabilityService {
  constructor(
    private readonly messageTrackingService: MessageTrackingService,
    @Inject(OBSERVER) private readonly observer: Observer,
  ) {}

  startTrace(options: AiStreamTraceOptions): AiStreamTrace {
    return new AiStreamTrace(this.messageTrackingService, this.observer, options);
  }
}

export class AiStreamTrace {
  private readonly logger = new Logger(AiStreamTrace.name);
  private readonly traceId: string;
  private readonly scenario: string;
  private readonly chunkTypeCounts: Record<string, number> = {};
  private readonly toolNames = new Set<string>();
  private readonly replyPreviewParts: string[] = [];
  private readonly reasoningPreviewParts: string[] = [];
  private readonly marks: AiStreamTraceMarks = {
    receivedAt: Date.now(),
  };

  private usage?: StreamUsage;
  private entryStage: string | null = null;
  private firstChunkType?: string;
  private finishReason?: string;
  private streamErrorText?: string;
  private stepCount = 0;
  private finalized = false;

  constructor(
    private readonly messageTrackingService: MessageTrackingService,
    private readonly observer: Observer,
    private readonly options: AiStreamTraceOptions,
  ) {
    this.traceId = `ai-stream:${options.chatId}:${randomUUID()}`;
    this.scenario = options.scenario || DEFAULT_SCENARIO;

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
    this.marks.workerStartAt = Date.now();

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

  markAiStart(): void {
    if (this.marks.aiStartAt) return;
    this.marks.aiStartAt = Date.now();
    this.messageTrackingService.recordAiStart(this.traceId);
  }

  markStreamReady(entryStage: string | null): void {
    this.entryStage = entryStage;
    this.marks.streamReadyAt = Date.now();
  }

  markResponsePipeStart(): void {
    if (this.marks.responsePipeStartAt) return;
    this.marks.responsePipeStartAt = Date.now();
    this.messageTrackingService.recordSendStart(this.traceId);
  }

  observeChunk(chunk: UIMessageChunk): void {
    const now = Date.now();
    this.chunkTypeCounts[chunk.type] = (this.chunkTypeCounts[chunk.type] || 0) + 1;

    if (!this.firstChunkType) {
      this.firstChunkType = chunk.type;
      this.marks.firstChunkAt = now;
    }

    switch (chunk.type) {
      case 'reasoning-start':
        this.marks.firstReasoningStartAt ??= now;
        break;
      case 'reasoning-delta':
        this.marks.firstReasoningDeltaAt ??= now;
        this.appendPreview(this.reasoningPreviewParts, chunk.delta);
        break;
      case 'text-start':
        this.marks.firstTextStartAt ??= now;
        break;
      case 'text-delta':
        this.marks.firstTextDeltaAt ??= now;
        this.appendPreview(this.replyPreviewParts, chunk.delta);
        break;
      case 'tool-input-start':
      case 'tool-input-available':
        this.toolNames.add(chunk.toolName);
        break;
      case 'start-step':
        this.stepCount += 1;
        break;
      case 'finish':
        this.finishReason = chunk.finishReason;
        this.marks.finishChunkAt = now;
        break;
      case 'error':
        this.streamErrorText = chunk.errorText;
        break;
      default:
        break;
    }
  }

  recordUsage(usage: StreamUsage): void {
    this.usage = usage;
    this.marks.usageResolvedAt = Date.now();
  }

  hasStreamError(): boolean {
    return Boolean(this.streamErrorText);
  }

  getStreamErrorMessage(): string | undefined {
    return this.streamErrorText;
  }

  getClientPayload(status: 'success' | 'failure', error?: string): AiStreamSummaryPayload {
    const completedAt = this.marks.completedAt ?? Date.now();
    const timings = this.buildTimings(completedAt);

    return {
      traceId: this.traceId,
      sessionId: this.options.chatId,
      scenario: this.scenario,
      status,
      entryStage: this.entryStage,
      firstChunkType: this.firstChunkType,
      finishReason: this.finishReason,
      error,
      usage: this.usage,
      chunkTypeCounts: { ...this.chunkTypeCounts },
      stepCount: this.stepCount,
      tools: Array.from(this.toolNames),
      hasReasoning:
        Boolean(this.marks.firstReasoningStartAt) || Boolean(this.marks.firstReasoningDeltaAt),
      hasText: Boolean(this.marks.firstTextStartAt) || Boolean(this.marks.firstTextDeltaAt),
      replyPreview: this.getPreview(this.replyPreviewParts),
      reasoningPreview: this.getPreview(this.reasoningPreviewParts),
      timings,
    };
  }

  finalizeSuccess(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.marks.completedAt = Date.now();

    if (this.marks.aiStartAt) {
      this.messageTrackingService.recordAiEnd(this.traceId);
    }
    if (this.marks.responsePipeStartAt) {
      this.messageTrackingService.recordSendEnd(this.traceId);
    }

    const payload = this.getClientPayload('success');
    const metadata = this.buildMonitoringMetadata(payload);

    this.messageTrackingService.recordSuccess(this.traceId, metadata);
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
    this.marks.completedAt = Date.now();

    if (this.marks.aiStartAt) {
      this.messageTrackingService.recordAiEnd(this.traceId);
    }
    if (this.marks.responsePipeStartAt) {
      this.messageTrackingService.recordSendEnd(this.traceId);
    }

    const errorMessage = this.toErrorMessage(error);
    const payload = this.getClientPayload('failure', errorMessage);
    const metadata = this.buildMonitoringMetadata(payload, errorMessage);

    this.messageTrackingService.recordFailure(this.traceId, errorMessage, metadata);
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
    return {
      scenario: this.scenario as MonitoringMetadata['scenario'],
      tools: payload.tools.length > 0 ? payload.tools : undefined,
      tokenUsage: payload.usage?.totalTokens ?? 0,
      replyPreview: payload.replyPreview,
      replySegments: this.chunkTypeCounts['text-delta'] ?? undefined,
      isFallback: false,
      agentInvocation: {
        request: this.options.requestBody,
        response: {
          ...payload,
          error: errorMessage ?? payload.error,
        },
        isFallback: false,
      },
    };
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
        steps: this.stepCount,
        totalTokens: payload.usage?.totalTokens ?? 0,
        durationMs: payload.timings.durations.totalMs,
      });
    }
  }

  private buildTimings(completedAt: number): AiStreamTimingPayload {
    return {
      timestamps: {
        ...this.marks,
        completedAt,
      },
      durations: {
        totalMs: completedAt - this.marks.receivedAt,
        requestToAiStartMs: this.diff(this.marks.aiStartAt, this.marks.receivedAt),
        requestToStreamReadyMs: this.diff(this.marks.streamReadyAt, this.marks.receivedAt),
        requestToResponsePipeStartMs: this.diff(
          this.marks.responsePipeStartAt,
          this.marks.receivedAt,
        ),
        requestToFirstChunkMs: this.diff(this.marks.firstChunkAt, this.marks.receivedAt),
        requestToFirstReasoningStartMs: this.diff(
          this.marks.firstReasoningStartAt,
          this.marks.receivedAt,
        ),
        requestToFirstReasoningDeltaMs: this.diff(
          this.marks.firstReasoningDeltaAt,
          this.marks.receivedAt,
        ),
        requestToFirstTextStartMs: this.diff(this.marks.firstTextStartAt, this.marks.receivedAt),
        requestToFirstTextDeltaMs: this.diff(this.marks.firstTextDeltaAt, this.marks.receivedAt),
        aiStartToStreamReadyMs: this.diff(this.marks.streamReadyAt, this.marks.aiStartAt),
        streamReadyToResponsePipeStartMs: this.diff(
          this.marks.responsePipeStartAt,
          this.marks.streamReadyAt,
        ),
        responsePipeStartToFirstChunkMs: this.diff(
          this.marks.firstChunkAt,
          this.marks.responsePipeStartAt,
        ),
        firstChunkToFinishMs: this.diff(completedAt, this.marks.firstChunkAt),
        responsePipeStartToFinishMs: this.diff(completedAt, this.marks.responsePipeStartAt),
        requestToUsageResolvedMs: this.diff(this.marks.usageResolvedAt, this.marks.receivedAt),
      },
    };
  }

  private appendPreview(parts: string[], delta: string): void {
    const currentLength = this.getPreviewLength(parts);

    if (!delta || currentLength >= PREVIEW_LIMIT) {
      return;
    }

    const nextLength = currentLength + delta.length;
    if (nextLength <= PREVIEW_LIMIT) {
      parts.push(delta);
      return;
    }

    parts.push(delta.slice(0, PREVIEW_LIMIT - currentLength));
  }

  private getPreview(parts: string[]): string | undefined {
    const text = parts.join('').trim();
    return text || undefined;
  }

  private getPreviewLength(parts: string[]): number {
    return this.getPreview(parts)?.length ?? 0;
  }

  private diff(to?: number, from?: number): number | undefined {
    if (to === undefined || from === undefined) return undefined;
    return Math.max(to - from, 0);
  }

  private toErrorMessage(error: unknown): string {
    if (typeof error === 'string') return error;
    if (error instanceof Error) return error.message;
    return 'Unknown ai-stream error';
  }
}
