import type {
  AiStreamSummaryPayload,
  CapturedToolCall,
  ContentKind,
  ContentOrderItem,
  StoredAiStreamResponse,
  StoredReplyPayload,
  StoredToolCall,
  StoredUiMessage,
  StoredUiMessagePart,
  StreamUsage,
  ToolCallState,
} from './ai-stream-trace';

const PREVIEW_LIMIT = 500;

export class AiStreamTraceContentStore {
  private readonly chunkTypeCounts: Record<string, number> = {};
  private readonly toolNames = new Set<string>();
  private readonly replyPreviewParts: string[] = [];
  private readonly reasoningPreviewParts: string[] = [];
  private readonly textBlocks = new Map<string, string[]>();
  private readonly reasoningBlocks = new Map<string, string[]>();
  private readonly toolCalls = new Map<string, CapturedToolCall>();
  private readonly contentOrder: ContentOrderItem[] = [];

  private firstChunkType?: string;
  private finishReason?: string;
  private streamErrorText?: string;
  private stepCount = 0;
  private sawReasoning = false;
  private sawText = false;

  recordChunkType(type: string): boolean {
    this.chunkTypeCounts[type] = (this.chunkTypeCounts[type] || 0) + 1;
    if (this.firstChunkType) return false;
    this.firstChunkType = type;
    return true;
  }

  startReasoningBlock(id: string): void {
    this.sawReasoning = true;
    this.ensureReasoningBlock(id);
  }

  appendReasoningDelta(id: string, delta: string): void {
    this.sawReasoning = true;
    this.ensureReasoningBlock(id).push(delta);
    this.appendPreview(this.reasoningPreviewParts, delta);
  }

  startTextBlock(id: string): void {
    this.sawText = true;
    this.ensureTextBlock(id);
  }

  appendTextDelta(id: string, delta: string): void {
    this.sawText = true;
    this.ensureTextBlock(id).push(delta);
    this.appendPreview(this.replyPreviewParts, delta);
  }

  beginToolInput(
    toolCallId: string,
    patch: {
      toolName?: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    },
  ): void {
    if (patch.toolName) {
      this.toolNames.add(patch.toolName);
    }
    this.ensureToolCall(toolCallId, {
      ...patch,
      state: 'input-streaming',
    });
  }

  appendToolInputDelta(toolCallId: string, inputTextDelta: string): void {
    this.ensureToolCall(toolCallId).inputTextParts.push(inputTextDelta);
  }

  setToolInputAvailable(
    toolCallId: string,
    patch: {
      toolName?: string;
      input?: unknown;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    },
  ): void {
    if (patch.toolName) {
      this.toolNames.add(patch.toolName);
    }
    this.ensureToolCall(toolCallId, {
      ...patch,
      state: 'input-available',
    });
  }

  setToolInputError(
    toolCallId: string,
    patch: {
      toolName?: string;
      input?: unknown;
      errorText?: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
      title?: string;
    },
  ): void {
    if (patch.toolName) {
      this.toolNames.add(patch.toolName);
    }
    this.ensureToolCall(toolCallId, {
      ...patch,
      state: 'input-error',
    });
  }

  setToolOutputAvailable(
    toolCallId: string,
    patch: {
      output?: unknown;
      providerExecuted?: boolean;
      dynamic?: boolean;
      preliminary?: boolean;
    },
  ): void {
    this.ensureToolCall(toolCallId, {
      ...patch,
      state: 'output-available',
    });
  }

  setToolOutputError(
    toolCallId: string,
    patch: {
      errorText?: string;
      providerExecuted?: boolean;
      dynamic?: boolean;
    },
  ): void {
    this.ensureToolCall(toolCallId, {
      ...patch,
      state: 'output-error',
    });
  }

  setToolOutputDenied(toolCallId: string): void {
    this.ensureToolCall(toolCallId, {
      state: 'output-denied',
    });
  }

  incrementStepCount(): void {
    this.stepCount += 1;
  }

  markFinish(finishReason?: string): void {
    this.finishReason = finishReason;
  }

  markError(errorText: string): void {
    this.streamErrorText = errorText;
  }

  hasStreamError(): boolean {
    return Boolean(this.streamErrorText);
  }

  getStreamErrorMessage(): string | undefined {
    return this.streamErrorText;
  }

  getFirstChunkType(): string | undefined {
    return this.firstChunkType;
  }

  getFinishReason(): string | undefined {
    return this.finishReason;
  }

  getChunkTypeCounts(): Record<string, number> {
    return { ...this.chunkTypeCounts };
  }

  getStepCount(): number {
    return this.stepCount;
  }

  getTools(): string[] {
    return Array.from(this.toolNames);
  }

  hasReasoning(): boolean {
    return this.sawReasoning;
  }

  hasText(): boolean {
    return this.sawText;
  }

  getReplyPreview(): string | undefined {
    return this.getPreview(this.replyPreviewParts);
  }

  getReasoningPreview(): string | undefined {
    return this.getPreview(this.reasoningPreviewParts);
  }

  buildStoredResponse(
    payload: AiStreamSummaryPayload,
    traceId: string,
    errorMessage?: string,
  ): StoredAiStreamResponse {
    const toolCalls = this.buildStoredToolCalls();
    const reply = this.buildReplyPayload(payload.usage);
    const messages = this.buildAssistantMessages(traceId);

    return {
      ...payload,
      error: errorMessage ?? payload.error,
      reply,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      messages: messages.length > 0 ? messages : undefined,
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

  private buildReplyPayload(usage?: StreamUsage): StoredReplyPayload | undefined {
    const content = this.collectOrderedText('text', '');
    const reasoning = this.collectOrderedText('reasoning', '\n\n');

    if (!content && !reasoning && !usage) return undefined;

    return {
      content: content || undefined,
      reasoning: reasoning || undefined,
      usage,
    };
  }

  private collectOrderedText(
    kind: Extract<ContentKind, 'text' | 'reasoning'>,
    separator: string,
  ): string {
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

  private buildAssistantMessages(traceId: string): StoredUiMessage[] {
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
        id: `assistant-${traceId}`,
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
    if (!delta || currentLength >= PREVIEW_LIMIT) return;

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
}
