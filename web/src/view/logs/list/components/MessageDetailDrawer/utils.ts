import type { UIMessage } from 'ai';
import type { MessageRecord } from '@/api/types/chat.types';

type AnyRecord = Record<string, unknown>;

export interface TimingMetrics {
  e2eMs?: number;
  queueWaitMs?: number;
  prepMs?: number;
  llmMs?: number;
  deliveryMs?: number;
  ttftMs?: number;
  ttfrMs?: number;
  firstChunkMs?: number;
}

export interface ToolCallInfo {
  name: string;
  status: 'success' | 'error' | 'unknown';
  input?: unknown;
  output?: unknown;
}

export interface RawPayloadPanel {
  key: string;
  label: string;
  description: string;
  data: unknown;
}

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as AnyRecord)
    : undefined;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function buildTextPart(text: string) {
  return { type: 'text' as const, text };
}

function normalizeMessageParts(parts: unknown): UIMessage['parts'] {
  return asArray<AnyRecord>(parts).reduce<UIMessage['parts']>((acc, part, index) => {
    const partType = asString(part.type);
    if (!partType) return acc;

    if (partType === 'text') {
      const text = asString(part.text);
      if (text) acc.push(buildTextPart(text));
      return acc;
    }

    if (partType === 'reasoning') {
      const text = asString(part.text);
      if (text) {
        acc.push({
          type: 'reasoning',
          text,
        } as UIMessage['parts'][number]);
      }
      return acc;
    }

    if (partType === 'dynamic-tool' || partType.startsWith('tool-')) {
      const toolName = asString(part.toolName) || partType.replace(/^tool-/, '') || 'unknown-tool';
      acc.push({
        type: `tool-${toolName}`,
        toolName,
        toolCallId: asString(part.toolCallId) || `${toolName}-${index}`,
        input: part.input,
        output: part.output ?? part.result,
        state:
          part.state === 'error' || part.state === 'output-error'
            ? 'output-error'
            : part.output !== undefined || part.result !== undefined || part.state === 'output-available'
              ? 'output-available'
              : 'input-available',
      } as UIMessage['parts'][number]);
    }

    return acc;
  }, []);
}

export function getAssistantRenderableMessage(message: MessageRecord): UIMessage | undefined {
  const response = getInvocationResponse(message);
  const responseMessages = asArray<AnyRecord>(response?.messages);

  for (let i = responseMessages.length - 1; i >= 0; i -= 1) {
    const candidate = responseMessages[i];
    if (candidate.role !== 'assistant') continue;

    const parts = normalizeMessageParts(candidate.parts);
    if (parts.length > 0) {
      return {
        id: asString(candidate.id) || `assistant-${message.messageId || i}`,
        role: 'assistant',
        parts,
      } as UIMessage;
    }
  }

  const syntheticParts: UIMessage['parts'] = [];
  const reasoningPreview = asString(response?.reasoningPreview);
  if (reasoningPreview) {
    syntheticParts.push({
      type: 'reasoning',
      text: reasoningPreview,
    } as UIMessage['parts'][number]);
  }

  const directToolCalls = asArray<AnyRecord>(response?.toolCalls);
  directToolCalls.forEach((toolCall, index) => {
    const toolName = asString(toolCall.toolName) || `tool-${index + 1}`;
    syntheticParts.push({
      type: `tool-${toolName}`,
      toolName,
      toolCallId: asString(toolCall.toolCallId) || `${toolName}-${index}`,
      input: toolCall.input,
      output: toolCall.result ?? toolCall.output,
      state:
        toolCall.result !== undefined || toolCall.output !== undefined
          ? 'output-available'
          : toolCall.state === 'error'
            ? 'output-error'
            : 'input-available',
    } as UIMessage['parts'][number]);
  });

  const reply = asRecord(response?.reply);
  const replyContent = asString(reply?.content) || asString(response?.replyPreview) || message.replyPreview;
  if (replyContent) {
    syntheticParts.push(buildTextPart(replyContent));
  }

  if (syntheticParts.length === 0) return undefined;

  return {
    id: `assistant-synthetic-${message.messageId || message.chatId}`,
    role: 'assistant',
    parts: syntheticParts,
  } as UIMessage;
}

export function getStatusLabel(status: MessageRecord['status']): string {
  switch (status) {
    case 'success':
      return '成功';
    case 'failure':
    case 'failed':
      return '失败';
    case 'timeout':
      return '超时';
    case 'processing':
      return '处理中';
    default:
      return String(status);
  }
}

export function getStatusTone(
  status: MessageRecord['status'],
): 'success' | 'danger' | 'warning' {
  switch (status) {
    case 'success':
      return 'success';
    case 'failure':
    case 'failed':
    case 'timeout':
      return 'danger';
    default:
      return 'warning';
  }
}

export function getInvocationRequest(message: MessageRecord): AnyRecord | undefined {
  return asRecord(message.agentInvocation?.request);
}

export function getInvocationResponse(message: MessageRecord): AnyRecord | undefined {
  return asRecord(message.agentInvocation?.response);
}

function extractTextFromParts(parts: unknown): string {
  return asArray<AnyRecord>(parts)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part.text))
    .join('\n');
}

export function getResponseText(message: MessageRecord): string {
  const response = getInvocationResponse(message);
  const reply = asRecord(response?.reply);
  const directReply = asString(reply?.content);
  if (directReply) return directReply;

  const replyPreview = asString(response?.replyPreview);
  if (replyPreview) return replyPreview;

  const responseMessages = asArray<AnyRecord>(response?.messages);
  const assistantText = responseMessages
    .filter((item) => item.role === 'assistant')
    .map((item) => extractTextFromParts(item.parts))
    .filter(Boolean)
    .join('\n\n');

  if (assistantText) return assistantText;

  return message.replyPreview || '(无响应内容)';
}

export function getRawPayloadPanels(message: MessageRecord): RawPayloadPanel[] {
  const request = getInvocationRequest(message);
  const response = getInvocationResponse(message);
  const responseRecord = asRecord(response);
  const panels: RawPayloadPanel[] = [];

  if (request) {
    panels.push({
      key: 'request',
      label: 'Request',
      description: '发送到 Agent 的请求体',
      data: request,
    });
  }

  if (responseRecord) {
    panels.push({
      key: 'response',
      label: 'Response',
      description: 'Agent 返回的完整响应摘要',
      data: responseRecord,
    });
  }

  const delivery = asRecord(responseRecord?.delivery);
  if (delivery) {
    panels.push({
      key: 'delivery',
      label: 'Delivery',
      description: '下发回执与分段信息',
      data: delivery,
    });
  }

  const fallback = asRecord(responseRecord?.fallback);
  if (fallback) {
    panels.push({
      key: 'fallback',
      label: 'Fallback',
      description: '降级发送链路',
      data: fallback,
    });
  }

  if (message.agentInvocation?.http) {
    panels.push({
      key: 'http',
      label: 'HTTP',
      description: '调用链路的 HTTP 元信息',
      data: message.agentInvocation.http,
    });
  }

  if (message.error) {
    panels.push({
      key: 'error',
      label: 'Error',
      description: '最终记录到监控表的异常信息',
      data: message.error,
    });
  }

  return panels;
}

export function getHistoryMessages(message: MessageRecord): Array<{
  role: 'user' | 'assistant';
  content: string;
}> {
  const request = getInvocationRequest(message);
  const requestMessages = asArray<AnyRecord>(request?.messages);
  if (requestMessages.length === 0) return [];

  return requestMessages
    .map((item, index, arr) => {
      if (item.role === 'system') return null;

      const isLastUserMessage =
        item.role === 'user' && arr.slice(index + 1).every((candidate) => candidate.role !== 'user');
      if (isLastUserMessage) return null;

      const content = extractTextFromParts(item.parts);
      if (!content.trim()) return null;

      return {
        role: item.role === 'assistant' ? 'assistant' : 'user',
        content,
      };
    })
    .filter((item): item is { role: 'user' | 'assistant'; content: string } => Boolean(item));
}

function inferToolStatus(toolCall: AnyRecord): ToolCallInfo['status'] {
  const result = asRecord(toolCall.result) ?? asRecord(toolCall.output);
  if (result?.success === true) return 'success';
  if (toolCall.state === 'error' || result?.success === false) return 'error';
  return 'unknown';
}

export function getToolCalls(message: MessageRecord): ToolCallInfo[] {
  const response = getInvocationResponse(message);
  const directToolCalls = asArray<AnyRecord>(response?.toolCalls);
  if (directToolCalls.length > 0) {
    return directToolCalls.reduce<ToolCallInfo[]>((acc, toolCall) => {
        const name = asString(toolCall.toolName);
        if (!name) return acc;
        acc.push({
          name,
          status: inferToolStatus(toolCall),
          input: toolCall.input,
          output: toolCall.result ?? toolCall.output,
        });
        return acc;
      }, []);
  }

  const responseMessages = asArray<AnyRecord>(response?.messages);
  return responseMessages.flatMap((item) =>
    asArray<AnyRecord>(item.parts)
      .filter((part) => part.type === 'dynamic-tool')
      .map((part) => ({
        name: asString(part.toolName) || 'unknown-tool',
        status:
          part.state === 'output-available'
            ? 'success'
            : part.state === 'error'
              ? 'error'
              : 'unknown',
        input: part.input,
        output: part.output,
      })),
  );
}

export function getTimingMetrics(message: MessageRecord): TimingMetrics {
  const response = getInvocationResponse(message);
  const timings = asRecord(response?.timings);
  const durations = asRecord(timings?.durations);

  return {
    e2eMs: message.totalDuration ?? asNumber(durations?.totalMs),
    queueWaitMs: message.queueDuration ?? asNumber(durations?.acceptedToWorkerStartMs),
    prepMs: message.prepDuration ?? asNumber(durations?.workerStartToAiStartMs),
    llmMs: message.aiDuration ?? asNumber(durations?.aiStartToAiEndMs),
    deliveryMs:
      message.sendDuration ??
      asNumber(durations?.deliveryDurationMs) ??
      asNumber(durations?.responsePipeStartToFinishMs),
    ttftMs: asNumber(durations?.requestToFirstTextDeltaMs),
    ttfrMs: asNumber(durations?.requestToFirstReasoningDeltaMs),
    firstChunkMs: asNumber(durations?.requestToFirstChunkMs),
  };
}

export function getExecutionFacts(message: MessageRecord): Array<{ label: string; value: string }> {
  const request = getInvocationRequest(message);
  const response = getInvocationResponse(message);
  const facts: Array<{ label: string; value: string }> = [];

  const scenario = message.scenario || asString(request?.scenario);
  if (scenario) facts.push({ label: '场景', value: scenario });

  const dispatchMode = asString(request?.dispatchMode);
  if (dispatchMode) facts.push({ label: '分派模式', value: dispatchMode });

  const batchId = message.batchId || asString(request?.batchId);
  if (batchId) facts.push({ label: '批次 ID', value: batchId });

  if (message.isPrimary !== undefined) {
    facts.push({ label: '批次角色', value: message.isPrimary ? 'Primary' : 'Secondary' });
  }

  if (message.replySegments !== undefined) {
    facts.push({ label: '下发分段', value: String(message.replySegments) });
  }

  const entryStage = asString(response?.entryStage);
  if (entryStage) facts.push({ label: '入口阶段', value: entryStage });

  const finishReason = asString(response?.finishReason);
  if (finishReason) facts.push({ label: '结束原因', value: finishReason });

  const firstChunkType = asString(response?.firstChunkType);
  if (firstChunkType) facts.push({ label: '首个 Chunk', value: firstChunkType });

  const stepCount = asNumber(response?.stepCount);
  if (stepCount !== undefined) facts.push({ label: '执行步数', value: String(stepCount) });

  return facts;
}

export function getContextFacts(message: MessageRecord): Array<{
  label: string;
  value: string;
  mono?: boolean;
}> {
  const request = getInvocationRequest(message);
  const response = getInvocationResponse(message);
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [];

  if (message.chatId) facts.push({ label: 'Chat ID', value: message.chatId, mono: true });
  if (message.messageId) facts.push({ label: '消息 ID', value: message.messageId, mono: true });
  if (message.userId && message.userId !== message.userName) {
    facts.push({ label: 'User ID', value: message.userId, mono: true });
  }
  if (message.managerName) facts.push({ label: 'Owner', value: message.managerName });

  const messageType = asString(request?.messageType);
  if (messageType) facts.push({ label: 'Message Type', value: messageType });

  const messageSource = asString(request?.messageSource);
  if (messageSource) facts.push({ label: 'Source', value: messageSource });

  const contactType = asString(request?.contactType);
  if (contactType) facts.push({ label: 'Contact Type', value: contactType });

  const imageCount = asNumber(request?.imageCount);
  if (imageCount !== undefined && imageCount > 0) {
    facts.push({ label: 'Image Count', value: String(imageCount) });
  }

  const sessionId = asString(request?.sessionId);
  if (sessionId && sessionId !== message.chatId) {
    facts.push({ label: 'Session ID', value: sessionId, mono: true });
  }

  const thinking = asRecord(request?.thinking);
  if (thinking?.type === 'enabled') {
    const mode = 'Deep Thinking';
    facts.push({ label: 'Reasoning Profile', value: mode });
    const budgetTokens = asNumber(thinking.budgetTokens);
    if (budgetTokens !== undefined && budgetTokens > 0) {
      facts.push({ label: 'Budget Tokens', value: `${budgetTokens.toLocaleString()} tokens` });
    }
  }

  const traceId = asString(response?.traceId);
  if (traceId) facts.push({ label: 'Trace ID', value: traceId, mono: true });

  return facts;
}

export function getDeliverySummary(message: MessageRecord): AnyRecord | undefined {
  return asRecord(getInvocationResponse(message)?.delivery);
}

export function getFallbackSummary(message: MessageRecord): AnyRecord | undefined {
  return asRecord(getInvocationResponse(message)?.fallback);
}

export function getChunkSummary(message: MessageRecord): string | undefined {
  const response = getInvocationResponse(message);
  const chunkTypeCounts = asRecord(response?.chunkTypeCounts);
  if (!chunkTypeCounts) return undefined;

  const entries = Object.entries(chunkTypeCounts)
    .filter(([, value]) => typeof value === 'number' && value > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  if (entries.length === 0) return undefined;

  return entries
    .slice(0, 4)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ');
}
