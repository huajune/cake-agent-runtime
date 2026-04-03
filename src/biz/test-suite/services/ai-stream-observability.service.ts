import { Inject, Injectable, Logger } from '@nestjs/common';
import type { UIMessageChunk } from 'ai';
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

type ContentKind = 'text' | 'reasoning' | 'tool';

interface ContentOrderItem {
  kind: ContentKind;
  id: string;
}

type ToolCallState =
  | 'input-streaming'
  | 'input-available'
  | 'input-error'
  | 'output-available'
  | 'output-error'
  | 'output-denied';

interface CapturedToolCall {
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

interface StoredToolCall {
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

interface StoredUiMessagePart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  state?: 'input-available' | 'output-available' | 'output-error';
  errorText?: string;
}

interface StoredUiMessage {
  id: string;
  role: 'assistant';
  parts: StoredUiMessagePart[];
}

interface StoredReplyPayload {
  content?: string;
  reasoning?: string;
  usage?: StreamUsage;
}

interface StoredAiStreamResponse extends AiStreamSummaryPayload {
  reply?: StoredReplyPayload;
  toolCalls?: StoredToolCall[];
  messages?: StoredUiMessage[];
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
  private readonly textBlocks = new Map<string, string[]>();
  private readonly reasoningBlocks = new Map<string, string[]>();
  private readonly toolCalls = new Map<string, CapturedToolCall>();
  private readonly contentOrder: ContentOrderItem[] = [];
  private readonly marks: AiStreamTraceMarks = {
    receivedAt: Date.now(),
  };

  private requestBody: Record<string, unknown>;
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
    this.requestBody = options.requestBody;

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

  mergeRequestBody(partial: Record<string, unknown>): void {
    this.requestBody = {
      ...this.requestBody,
      ...partial,
    };
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
        this.ensureReasoningBlock(chunk.id);
        break;
      case 'reasoning-delta':
        this.marks.firstReasoningDeltaAt ??= now;
        this.ensureReasoningBlock(chunk.id).push(chunk.delta);
        this.appendPreview(this.reasoningPreviewParts, chunk.delta);
        break;
      case 'text-start':
        this.marks.firstTextStartAt ??= now;
        this.ensureTextBlock(chunk.id);
        break;
      case 'text-delta':
        this.marks.firstTextDeltaAt ??= now;
        this.ensureTextBlock(chunk.id).push(chunk.delta);
        this.appendPreview(this.replyPreviewParts, chunk.delta);
        break;
      case 'tool-input-start':
        this.toolNames.add(chunk.toolName);
        this.ensureToolCall(chunk.toolCallId, {
          toolName: chunk.toolName,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
          state: 'input-streaming',
        });
        break;
      case 'tool-input-delta':
        this.ensureToolCall(chunk.toolCallId).inputTextParts.push(chunk.inputTextDelta);
        break;
      case 'tool-input-available':
        this.toolNames.add(chunk.toolName);
        this.ensureToolCall(chunk.toolCallId, {
          toolName: chunk.toolName,
          input: chunk.input,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
          state: 'input-available',
        });
        break;
      case 'tool-input-error':
        this.toolNames.add(chunk.toolName);
        this.ensureToolCall(chunk.toolCallId, {
          toolName: chunk.toolName,
          input: chunk.input,
          errorText: chunk.errorText,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          title: chunk.title,
          state: 'input-error',
        });
        break;
      case 'tool-output-available':
        this.ensureToolCall(chunk.toolCallId, {
          output: chunk.output,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          preliminary: chunk.preliminary,
          state: 'output-available',
        });
        break;
      case 'tool-output-error':
        this.ensureToolCall(chunk.toolCallId, {
          errorText: chunk.errorText,
          providerExecuted: chunk.providerExecuted,
          dynamic: chunk.dynamic,
          state: 'output-error',
        });
        break;
      case 'tool-output-denied':
        this.ensureToolCall(chunk.toolCallId, {
          state: 'output-denied',
        });
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
    const storedResponse = this.buildStoredResponse(payload, errorMessage);

    return {
      scenario: this.scenario as MonitoringMetadata['scenario'],
      tools: payload.tools.length > 0 ? payload.tools : undefined,
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

  private buildStoredResponse(
    payload: AiStreamSummaryPayload,
    errorMessage?: string,
  ): StoredAiStreamResponse {
    const toolCalls = this.buildStoredToolCalls();
    const reply = this.buildReplyPayload();
    const messages = this.buildAssistantMessages();

    return {
      ...payload,
      error: errorMessage ?? payload.error,
      reply,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      messages: messages.length > 0 ? messages : undefined,
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

  private ensureContentOrder(kind: ContentKind, id: string): void {
    if (!id) return;
    if (this.contentOrder.some((item) => item.kind === kind && item.id === id)) return;
    this.contentOrder.push({ kind, id });
  }

  private ensureTextBlock(id: string): string[] {
    const existing = this.textBlocks.get(id);
    if (existing) return existing;
    const next: string[] = [];
    this.textBlocks.set(id, next);
    this.ensureContentOrder('text', id);
    return next;
  }

  private ensureReasoningBlock(id: string): string[] {
    const existing = this.reasoningBlocks.get(id);
    if (existing) return existing;
    const next: string[] = [];
    this.reasoningBlocks.set(id, next);
    this.ensureContentOrder('reasoning', id);
    return next;
  }

  private ensureToolCall(
    toolCallId: string,
    patch?: Partial<Omit<CapturedToolCall, 'toolCallId' | 'inputTextParts'>>,
  ): CapturedToolCall {
    const existing = this.toolCalls.get(toolCallId);
    if (existing) {
      if (patch) {
        Object.assign(existing, patch);
      }
      return existing;
    }

    const next: CapturedToolCall = {
      toolCallId,
      inputTextParts: [],
      state: patch?.state ?? 'input-streaming',
      toolName: patch?.toolName,
      input: patch?.input,
      output: patch?.output,
      errorText: patch?.errorText,
      providerExecuted: patch?.providerExecuted,
      dynamic: patch?.dynamic,
      title: patch?.title,
      preliminary: patch?.preliminary,
    };
    this.toolCalls.set(toolCallId, next);
    this.ensureContentOrder('tool', toolCallId);
    return next;
  }

  private buildReplyPayload(): StoredReplyPayload | undefined {
    const content = this.collectOrderedText('text', '');
    const reasoning = this.collectOrderedText('reasoning', '\n\n');

    if (!content && !reasoning && !this.usage) return undefined;

    return {
      content: content || undefined,
      reasoning: reasoning || undefined,
      usage: this.usage,
    };
  }

  private collectOrderedText(kind: Extract<ContentKind, 'text' | 'reasoning'>, separator: string) {
    const segments = this.contentOrder
      .filter((item) => item.kind === kind)
      .map((item) =>
        this.getJoinedText(
          kind === 'text' ? this.textBlocks.get(item.id) : this.reasoningBlocks.get(item.id),
        ),
      )
      .filter(Boolean);

    return segments.join(separator).trim();
  }

  private buildStoredToolCalls(): StoredToolCall[] {
    return this.contentOrder
      .filter((item) => item.kind === 'tool')
      .map((item) => this.toolCalls.get(item.id))
      .filter((tool): tool is CapturedToolCall => Boolean(tool?.toolName))
      .map((tool) => {
        const inputText = this.getJoinedText(tool.inputTextParts);
        return {
          toolCallId: tool.toolCallId,
          toolName: tool.toolName || 'unknown-tool',
          input: tool.input ?? this.parseToolInputText(inputText),
          inputText: inputText || undefined,
          output: tool.output,
          errorText: tool.errorText,
          state: tool.state,
          providerExecuted: tool.providerExecuted,
          dynamic: tool.dynamic,
          title: tool.title,
          preliminary: tool.preliminary,
        };
      });
  }

  private buildAssistantMessages(): StoredUiMessage[] {
    const parts = this.contentOrder.reduce<StoredUiMessagePart[]>((acc, item) => {
      if (item.kind === 'text') {
        const text = this.getJoinedText(this.textBlocks.get(item.id));
        if (text) {
          acc.push({ type: 'text', text });
        }
        return acc;
      }

      if (item.kind === 'reasoning') {
        const text = this.getJoinedText(this.reasoningBlocks.get(item.id));
        if (text) {
          acc.push({ type: 'reasoning', text });
        }
        return acc;
      }

      const tool = this.toolCalls.get(item.id);
      if (!tool?.toolName) return acc;

      acc.push({
        type: `tool-${tool.toolName}`,
        toolName: tool.toolName,
        toolCallId: tool.toolCallId,
        input: tool.input ?? this.parseToolInputText(this.getJoinedText(tool.inputTextParts)),
        output: tool.output ?? (tool.errorText ? { error: tool.errorText } : undefined),
        state: this.mapToolPartState(tool.state),
        errorText: tool.errorText,
      });

      return acc;
    }, []);

    if (parts.length === 0) return [];

    return [
      {
        id: `assistant-${this.traceId}`,
        role: 'assistant',
        parts,
      },
    ];
  }

  private mapToolPartState(
    state: ToolCallState,
  ): 'input-available' | 'output-available' | 'output-error' {
    switch (state) {
      case 'output-available':
        return 'output-available';
      case 'output-error':
      case 'output-denied':
      case 'input-error':
        return 'output-error';
      default:
        return 'input-available';
    }
  }

  private parseToolInputText(inputText?: string): unknown {
    if (!inputText) return undefined;
    try {
      return JSON.parse(inputText);
    } catch {
      return inputText;
    }
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

  private getJoinedText(parts?: string[]): string {
    if (!parts || parts.length === 0) return '';
    return parts.join('').trim();
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
