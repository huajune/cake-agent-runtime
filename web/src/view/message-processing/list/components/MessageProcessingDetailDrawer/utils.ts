import type { UIMessage } from 'ai';
import type {
  MessageRecord,
  MessageRecordMemorySnapshot,
  MessageRecordToolCallStatus,
} from '@/api/types/chat.types';
import { asRecord } from '@/utils/object';
import { buildAgentResponseTimeline, type AgentTimelinePart } from './agent-response-timeline';

type AnyRecord = Record<string, unknown>;

export interface TimingMetrics {
  e2eMs?: number;
  quietWindowWaitMs?: number;
  preDispatchMs?: number;
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
  status: MessageRecordToolCallStatus;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  resultCount?: number;
  durationMs?: number;
  errorType?: string;
  apiCode?: string | number;
}

export interface RawPayloadPanel {
  key: string;
  label: string;
  description: string;
  data: unknown;
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

function buildResponsePayload(response?: AnyRecord): AnyRecord | undefined {
  if (!response) return undefined;

  const payload: AnyRecord = {};
  const reply = asRecord(response.reply);
  const messages = asArray(response.messages);
  const toolCalls = asArray(response.toolCalls);
  const hasCoreResponse = Boolean(reply) || messages.length > 0 || toolCalls.length > 0;

  if (reply) payload.reply = reply;
  if (messages.length > 0) payload.messages = messages;
  if (toolCalls.length > 0) payload.toolCalls = toolCalls;

  if (!hasCoreResponse) return undefined;

  const usage = asRecord(response.usage);
  if (usage) payload.usage = usage;

  const finishReason = asString(response.finishReason);
  if (finishReason) payload.finishReason = finishReason;

  const entryStage = asString(response.entryStage);
  if (entryStage) payload.entryStage = entryStage;

  const status = asString(response.status);
  if (status) payload.status = status;

  const error = asString(response.error);
  if (error) payload.error = error;

  return Object.keys(payload).length > 0 ? payload : response;
}

function buildTracePayload(response?: AnyRecord): AnyRecord | undefined {
  if (!response) return undefined;

  const payload: AnyRecord = {};
  const traceId = asString(response.traceId);
  if (traceId) payload.traceId = traceId;

  const timings = asRecord(response.timings);
  if (timings) payload.timings = timings;

  const chunkTypeCounts = asRecord(response.chunkTypeCounts);
  if (chunkTypeCounts) payload.chunkTypeCounts = chunkTypeCounts;

  const stepCount = asNumber(response.stepCount);
  if (stepCount !== undefined) payload.stepCount = stepCount;

  const firstChunkType = asString(response.firstChunkType);
  if (firstChunkType) payload.firstChunkType = firstChunkType;

  const hasReasoning = response.hasReasoning;
  if (typeof hasReasoning === 'boolean') payload.hasReasoning = hasReasoning;

  const hasText = response.hasText;
  if (typeof hasText === 'boolean') payload.hasText = hasText;

  return Object.keys(payload).length > 0 ? payload : undefined;
}

function buildDebugRequestContext(request?: AnyRecord): AnyRecord | undefined {
  if (!request) return undefined;

  const {
    agentRequest: _agentRequest,
    normalizedRequest: _normalizedRequest,
    transportRequest: _transportRequest,
    ...rest
  } = request;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function buildMemorySnapshotPayload(snapshot?: MessageRecordMemorySnapshot): AnyRecord | undefined {
  if (!snapshot) return undefined;

  const entries: AnyRecord = {};
  if (snapshot.currentStage) entries['程序性阶段'] = snapshot.currentStage;
  if (snapshot.presentedJobIds && snapshot.presentedJobIds.length > 0) {
    entries['本轮已展示岗位'] = snapshot.presentedJobIds;
  }
  if (snapshot.recommendedJobIds && snapshot.recommendedJobIds.length > 0) {
    entries['推荐记录'] = snapshot.recommendedJobIds;
  }
  if (snapshot.sessionFacts && Object.keys(snapshot.sessionFacts).length > 0) {
    entries['会话事实'] = snapshot.sessionFacts;
  }
  if (snapshot.profileKeys && snapshot.profileKeys.length > 0) {
    entries['长期画像 keys'] = snapshot.profileKeys;
  }

  return Object.keys(entries).length > 0 ? entries : undefined;
}

function buildTextPart(text: string) {
  return { type: 'text' as const, text };
}

function buildToolPart(params: {
  toolName: string;
  toolCallId: string;
  input?: unknown;
  output?: unknown;
  errorText?: string;
  state?: 'input-available' | 'output-available' | 'output-error';
}) {
  const { toolName, toolCallId, input, output, errorText } = params;
  const state =
    params.state ??
    (errorText ? 'output-error' : output !== undefined ? 'output-available' : 'input-available');

  return {
    type: `tool-${toolName}`,
    toolName,
    toolCallId,
    input,
    output,
    state,
    errorText,
  } as UIMessage['parts'][number];
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
      acc.push(
        buildToolPart({
          toolName,
          toolCallId: asString(part.toolCallId) || `${toolName}-${index}`,
          input: part.input ?? part.args ?? part.arguments,
          output: part.output ?? part.result,
          errorText: asString(part.errorText) || asString(part.error),
          state:
            part.state === 'error' || part.state === 'output-error'
              ? 'output-error'
              : part.output !== undefined ||
                  part.result !== undefined ||
                  part.state === 'output-available'
                ? 'output-available'
                : 'input-available',
        }),
      );
    }

    return acc;
  }, []);
}

function buildRenderablePartsFromResponseMessages(
  responseMessages: AnyRecord[],
): UIMessage['parts'] {
  const parts: UIMessage['parts'] = [];
  const toolPartIndexById = new Map<string, number>();
  type ToolLikePart = UIMessage['parts'][number] & {
    toolCallId?: string;
    input?: unknown;
    output?: unknown;
    errorText?: string;
    state?: unknown;
  };

  const rememberToolPart = (part: UIMessage['parts'][number], index: number) => {
    const toolCallId = (part as { toolCallId?: string }).toolCallId;
    if (part.type.startsWith('tool-') && toolCallId) {
      toolPartIndexById.set(toolCallId, index);
    }
  };

  const pushPart = (part: UIMessage['parts'][number]) => {
    parts.push(part);
    rememberToolPart(part, parts.length - 1);
  };

  const mergeToolUpdate = (contentPart: AnyRecord, index: number) => {
    const toolName =
      asString(contentPart.toolName) ||
      asString(contentPart.tool) ||
      asString(contentPart.name) ||
      `tool-${index + 1}`;
    const toolCallId = asString(contentPart.toolCallId) || `${toolName}-${index}`;
    const errorText = asString(contentPart.errorText) || asString(contentPart.error) || undefined;
    const output =
      contentPart.output ?? contentPart.result ?? (errorText ? { error: errorText } : undefined);
    const nextPart = buildToolPart({
      toolName,
      toolCallId,
      input: contentPart.input ?? contentPart.args ?? contentPart.arguments,
      output,
      errorText,
      state:
        errorText || contentPart.type === 'tool-error'
          ? 'output-error'
          : output !== undefined
            ? 'output-available'
            : 'input-available',
    }) as ToolLikePart;

    const existingIndex = toolPartIndexById.get(toolCallId);
    if (existingIndex !== undefined) {
      const existing = parts[existingIndex] as ToolLikePart;
      parts[existingIndex] = {
        ...existing,
        input: existing.input ?? nextPart.input,
        output: nextPart.output,
        errorText: nextPart.errorText,
        state: nextPart.state,
      } as UIMessage['parts'][number];
      rememberToolPart(parts[existingIndex], existingIndex);
      return;
    }

    pushPart(nextPart);
  };

  responseMessages.forEach((message, messageIndex) => {
    const uiParts = normalizeMessageParts(message.parts);
    if (uiParts.length > 0) {
      uiParts.forEach((part) => pushPart(part));
      return;
    }

    const content = asArray<AnyRecord>(message.content);
    if (content.length === 0) return;

    content.forEach((contentPart, contentIndex) => {
      const partType = asString(contentPart.type);
      if (!partType) return;

      if (partType === 'text') {
        const text = asString(contentPart.text);
        if (text) pushPart(buildTextPart(text));
        return;
      }

      if (partType === 'reasoning') {
        const text = asString(contentPart.text);
        if (text) {
          pushPart({
            type: 'reasoning',
            text,
          } as UIMessage['parts'][number]);
        }
        return;
      }

      if (partType === 'tool-call') {
        const toolName =
          asString(contentPart.toolName) ||
          asString(contentPart.tool) ||
          asString(contentPart.name) ||
          `tool-${messageIndex + 1}-${contentIndex + 1}`;
        pushPart(
          buildToolPart({
            toolName,
            toolCallId:
              asString(contentPart.toolCallId) || `${toolName}-${messageIndex}-${contentIndex}`,
            input: contentPart.input ?? contentPart.args ?? contentPart.arguments,
          }),
        );
        return;
      }

      if (partType === 'tool-result' || partType === 'tool-error') {
        mergeToolUpdate(contentPart, messageIndex * 100 + contentIndex);
      }
    });
  });

  return parts;
}

export function getAssistantRenderableMessage(message: MessageRecord): UIMessage | undefined {
  const response = getInvocationResponse(message);
  const responseMessages = asArray<AnyRecord>(response?.messages);
  const invocationToolCalls = asArray<AnyRecord>(response?.toolCalls);
  const directToolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : invocationToolCalls.map((toolCall) => ({
        toolName:
          asString(toolCall.toolName) ||
          asString(toolCall.tool) ||
          asString(toolCall.name) ||
          'unknown-tool',
        args: toolCall.input ?? toolCall.args ?? toolCall.arguments ?? {},
        result: toolCall.result ?? toolCall.output,
        status: inferToolStatus(toolCall),
      }));
  const reply = asRecord(response?.reply);
  const replyReasoning = asString(reply?.reasoning) || asString(response?.reasoningPreview);
  const replyContent =
    asString(reply?.content) || asString(response?.replyPreview) || message.replyPreview;
  const responseParts = buildRenderablePartsFromResponseMessages(
    responseMessages,
  ) as AgentTimelinePart[];
  const timelineParts = buildAgentResponseTimeline({
    steps: message.agentSteps ?? undefined,
    responseParts,
    directToolCalls: directToolCalls.map((toolCall) => ({
      toolName: toolCall.toolName,
      args: toolCall.args,
      result: toolCall.result,
      status: toolCall.status,
    })),
    finalReasoning: replyReasoning,
    finalText: replyContent,
  });

  if (timelineParts.length === 0) return undefined;

  return {
    id: `assistant-timeline-${message.messageId || message.chatId}`,
    role: 'assistant',
    parts: timelineParts as UIMessage['parts'],
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
): 'success' | 'danger' | 'warning' | 'info' {
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

const SUPERSEDED_SUCCESS_MARKER = '补处理成功';

export function isSupersededTimeout(message: Pick<MessageRecord, 'status' | 'error'>): boolean {
  return (
    message.status === 'timeout' &&
    typeof message.error === 'string' &&
    message.error.includes(SUPERSEDED_SUCCESS_MARKER)
  );
}

export function getRecordStatusLabel(message: MessageRecord): string {
  return isSupersededTimeout(message) ? '已接管' : getStatusLabel(message.status);
}

export function getRecordStatusTone(
  message: MessageRecord,
): 'success' | 'danger' | 'warning' | 'info' {
  return isSupersededTimeout(message) ? 'info' : getStatusTone(message.status);
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

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }

        const record = asRecord(part);
        if (!record) {
          return '';
        }

        if (record.type === 'text' && typeof record.text === 'string') {
          return record.text;
        }

        if (typeof record.content === 'string') {
          return record.content;
        }

        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  return '';
}

function extractMessageContent(item: AnyRecord): string {
  const partsText = extractTextFromParts(item.parts);
  if (partsText.trim()) {
    return partsText;
  }

  const contentText = extractTextFromContent(item.content);
  if (contentText.trim()) {
    return contentText;
  }

  const text = asString(item.text);
  if (text) {
    return text;
  }

  return '';
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

/**
 * 把 agentRequest 还原成可读的最终提示词全文。
 *
 * agent_invocation.request.agentRequest 里存了完整的 instructions（旧记录为 system，
 * 含注入的
 * [用户档案] / [会话记忆] / [历史求职意向] 等记忆段）和消息序列，但 "LLM 请求"
 * tab 以 JSON 展示，长文本被转义成单行没法读——排障时"模型到底看到了什么记忆"
 * 一直回答不了（张漪 case 排查时只能去库里 substring）。这里拼成纯文本面板。
 */
function buildFinalPromptText(agentRequest?: AnyRecord): string | undefined {
  if (!agentRequest) return undefined;

  const sections: string[] = [];

  const modelId = asString(agentRequest.modelId);
  if (modelId) {
    sections.push(`模型: ${modelId}`);
  }

  const instructions = asString(agentRequest.instructions) ?? asString(agentRequest.system);
  if (instructions) {
    sections.push(
      `━━━━━━━━━━ Instructions（${instructions.length} 字符） ━━━━━━━━━━\n\n${instructions}`,
    );
  }

  const messages = asArray<AnyRecord>(agentRequest.messages);
  if (messages.length > 0) {
    const rendered = messages
      .map((item, index) => {
        const role = asString(item.role) ?? 'unknown';
        const text = extractMessageContent(item) || '（非文本内容，见 LLM 请求 tab）';
        return `#${index + 1} [${role}]\n${text}`;
      })
      .join('\n\n');
    sections.push(`━━━━━━━━━━ Messages（${messages.length} 条） ━━━━━━━━━━\n\n${rendered}`);
  }

  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

export function getRawPayloadPanels(message: MessageRecord): RawPayloadPanel[] {
  const request = getInvocationRequest(message);
  const response = getInvocationResponse(message);
  const responseRecord = asRecord(response);
  const panels: RawPayloadPanel[] = [];

  const agentRequest = asRecord(request?.agentRequest);
  const debugRequestContext = buildDebugRequestContext(request);
  const normalizedRequest = asRecord(request?.normalizedRequest);
  const transportRequest = asRecord(request?.transportRequest);
  const requestPayload = agentRequest || normalizedRequest || request;

  if (requestPayload) {
    panels.push({
      key: 'request',
      label: agentRequest ? 'LLM 请求' : '请求体',
      description: agentRequest ? '实际发往大模型的请求快照' : '发送到 Agent 的完整业务请求',
      data: requestPayload,
    });
  }

  const finalPromptText = buildFinalPromptText(agentRequest);
  if (finalPromptText) {
    panels.push({
      key: 'final-prompt',
      label: '最终提示词',
      description:
        '发往大模型的完整 instructions（兼容旧记录的 system，含 [用户档案]/[会话记忆]/[历史求职意向] 等注入的记忆段）与消息序列，纯文本可读视图',
      data: finalPromptText,
    });
  }

  if (debugRequestContext) {
    panels.push({
      key: 'debug-context',
      label: '排障上下文',
      description: '处理记录里的链路标识、会话信息与调度上下文',
      data: debugRequestContext,
    });
  }

  const memorySnapshotPayload = buildMemorySnapshotPayload(message.memorySnapshot);
  if (memorySnapshotPayload) {
    panels.push({
      key: 'memory-snapshot',
      label: '记忆快照',
      description: '本轮 Agent 触发时的四层记忆上下文（阶段 / 会话事实 / 推荐记录 / 画像 keys）',
      data: memorySnapshotPayload,
    });
  }

  if (transportRequest) {
    panels.push({
      key: 'transport-request',
      label: '传输请求',
      description: '前端发送到测试接口的原始请求体',
      data: transportRequest,
    });
  }

  if (normalizedRequest && agentRequest) {
    panels.push({
      key: 'normalized-request',
      label: '标准化请求',
      description: '测试接口归一化后的请求体',
      data: normalizedRequest,
    });
  }

  const responsePayload = buildResponsePayload(responseRecord);
  if (responsePayload) {
    panels.push({
      key: 'response',
      label: '响应体',
      description: 'Agent 返回的完整业务响应体',
      data: responsePayload,
    });
  }

  const toolCalls = Array.isArray(message.toolCalls)
    ? message.toolCalls
    : asArray<AnyRecord>(responseRecord?.toolCalls);
  if (toolCalls.length > 0) {
    panels.push({
      key: 'tool-calls',
      label: '工具执行',
      description: '工具调用明细（入参 / 出参 / 状态）',
      data: toolCalls,
    });
  }

  const tracePayload = buildTracePayload(responseRecord);
  if (tracePayload) {
    panels.push({
      key: 'trace',
      label: 'Trace',
      description: '流式处理观测信息与时延分解',
      data: tracePayload,
    });
  }

  const delivery = asRecord(responseRecord?.delivery);
  if (delivery) {
    panels.push({
      key: 'delivery',
      label: '回执下发',
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
  const requestCandidates = [
    asRecord(request?.agentRequest),
    asRecord(request?.normalizedRequest),
    asRecord(request?.transportRequest),
    request,
  ].filter((candidate): candidate is AnyRecord => Boolean(candidate));

  const normalizeConversationMessages = (
    items: AnyRecord[],
  ): Array<{ role: 'user' | 'assistant'; content: string }> =>
    items
      .map((item) => {
        if (item.role === 'system') return null;

        const content = extractMessageContent(item);
        if (!content.trim()) return null;

        return {
          role: item.role === 'assistant' ? 'assistant' : 'user',
          content,
        };
      })
      .filter((item): item is { role: 'user' | 'assistant'; content: string } => Boolean(item));

  for (const candidate of requestCandidates) {
    const requestMessages = asArray<AnyRecord>(candidate.messages);
    const historyMessages = asArray<AnyRecord>(candidate.history);

    if (requestMessages.length > 0) {
      const normalizedMessages = normalizeConversationMessages(requestMessages);
      if (normalizedMessages.length > 0) {
        return normalizedMessages;
      }
    }

    if (historyMessages.length > 0) {
      const normalizedMessages = normalizeConversationMessages(historyMessages);
      const currentUserMessage =
        asString(candidate.message) ||
        asString(candidate.userMessage) ||
        asString(candidate.content);

      if (currentUserMessage?.trim()) {
        const lastMessage = normalizedMessages[normalizedMessages.length - 1];
        if (
          !lastMessage ||
          lastMessage.role !== 'user' ||
          lastMessage.content.trim() !== currentUserMessage.trim()
        ) {
          normalizedMessages.push({
            role: 'user',
            content: currentUserMessage,
          });
        }
      }

      if (normalizedMessages.length > 0) {
        return normalizedMessages;
      }
    }
  }

  const reconstructedMessages: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  const currentUserMessage =
    requestCandidates
      .map((candidate) => asString(candidate.userMessage) || asString(candidate.content))
      .find(Boolean) || message.messagePreview;

  if (currentUserMessage?.trim()) {
    reconstructedMessages.push({
      role: 'user',
      content: currentUserMessage,
    });
  }

  const assistantReply = getResponseText(message);
  if (assistantReply && assistantReply !== '(无响应内容)') {
    reconstructedMessages.push({
      role: 'assistant',
      content: assistantReply,
    });
  }

  return reconstructedMessages;
}

function inferToolStatus(toolCall: AnyRecord): ToolCallInfo['status'] {
  const result = asRecord(toolCall.result) ?? asRecord(toolCall.output);
  if (result?.success === true) return 'ok';
  if (
    toolCall.state === 'error' ||
    toolCall.state === 'output-error' ||
    toolCall.state === 'input-error' ||
    toolCall.state === 'output-denied' ||
    result?.success === false
  ) {
    return 'error';
  }
  if (
    toolCall.state === 'output-available' ||
    toolCall.output !== undefined ||
    toolCall.result !== undefined
  ) {
    return 'ok';
  }
  return 'unknown';
}

export function getToolCalls(message: MessageRecord): ToolCallInfo[] {
  if (Array.isArray(message.toolCalls)) {
    return message.toolCalls.map((toolCall) => {
      const result = asRecord(toolCall.result);
      const nestedApiCode = result?.apiCode;
      return {
        name: toolCall.toolName,
        status: toolCall.status ?? 'unknown',
        input: toolCall.args,
        output: toolCall.result,
        resultCount: toolCall.resultCount,
        durationMs: toolCall.durationMs,
        errorType: toolCall.errorType ?? asString(result?.errorType),
        apiCode:
          toolCall.apiCode ??
          (typeof nestedApiCode === 'string' || typeof nestedApiCode === 'number'
            ? nestedApiCode
            : undefined),
      };
    });
  }

  const response = getInvocationResponse(message);
  const directToolCalls = asArray<AnyRecord>(response?.toolCalls);
  if (directToolCalls.length > 0) {
    return directToolCalls.reduce<ToolCallInfo[]>((acc, toolCall) => {
      const name = asString(toolCall.toolName);
      if (!name) return acc;
      const result = asRecord(toolCall.result ?? toolCall.output);
      const apiCode = toolCall.apiCode ?? result?.apiCode;
      acc.push({
        name,
        toolCallId: asString(toolCall.toolCallId),
        status: inferToolStatus(toolCall),
        input: toolCall.input ?? toolCall.args ?? toolCall.arguments,
        output: toolCall.result ?? toolCall.output,
        errorType:
          asString(toolCall.errorType) ??
          asString(result?.errorType),
        apiCode: typeof apiCode === 'string' || typeof apiCode === 'number' ? apiCode : undefined,
      });
      return acc;
    }, []);
  }

  const responseMessages = asArray<AnyRecord>(response?.messages);
  return responseMessages.flatMap((item) =>
    asArray<AnyRecord>(item.parts)
      .filter(
        (part) =>
          part.type === 'dynamic-tool' ||
          (typeof part.type === 'string' && part.type.startsWith('tool-')),
      )
      .map((part) => ({
        name:
          asString(part.toolName) || asString(part.type)?.replace(/^tool-/, '') || 'unknown-tool',
        toolCallId: asString(part.toolCallId),
        status:
          part.state === 'output-available'
            ? 'ok'
            : part.state === 'error' || part.state === 'output-error'
              ? 'error'
              : 'unknown',
        input: part.input ?? part.args,
        output: part.output ?? part.result,
      })),
  );
}

export function getTimingMetrics(message: MessageRecord): TimingMetrics {
  const response = getInvocationResponse(message);
  const timings = asRecord(response?.timings);
  const durations = asRecord(timings?.durations);

  return {
    e2eMs: message.totalDuration ?? asNumber(durations?.totalMs),
    quietWindowWaitMs: asNumber(durations?.quietWindowWaitMs),
    preDispatchMs: asNumber(durations?.acceptedToQueueAddMs),
    queueWaitMs:
      asNumber(durations?.queueMs) ??
      asNumber(durations?.queueWaitMs) ??
      message.queueDuration ??
      asNumber(durations?.acceptedToWorkerStartMs),
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

  if (message.replySegments !== undefined) {
    facts.push({ label: '下发分段', value: String(message.replySegments) });
  }

  const entryStage = asString(response?.entryStage);
  if (entryStage) facts.push({ label: '入口阶段', value: entryStage });

  const finishReason = asString(response?.finishReason);
  if (finishReason) facts.push({ label: '结束原因', value: finishReason });

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
  const facts: Array<{ label: string; value: string; mono?: boolean }> = [];
  const candidateName =
    message.userName ||
    asString(request?.userName) ||
    asString(request?.contactName) ||
    asString(request?.candidateName);
  const managerName =
    message.managerName ||
    asString(request?.managerName) ||
    asString(request?.botUserId) ||
    asString(request?.botName);
  const batchId = message.batchId || asString(request?.batchId);

  if (candidateName) facts.push({ label: '候选人昵称', value: candidateName });
  if (managerName) facts.push({ label: '托管 BOT', value: managerName });
  if (message.chatId) facts.push({ label: 'Chat ID', value: message.chatId, mono: true });
  if (batchId) facts.push({ label: 'Batch ID', value: batchId, mono: true });

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
