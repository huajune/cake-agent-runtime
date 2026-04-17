// ==================== 聊天会话类型 ====================

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  messageType?: string;
  payload?: Record<string, unknown>;
  source?: string;
  contactType?: string;
  isSelf?: boolean;
  avatar?: string;
  externalUserId?: string;
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ChatSession {
  chatId: string;
  candidateName?: string;
  managerName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
  avatar?: string;
  contactType?: string;
}

export interface ChatDailyStatsItem {
  date: string;
  messageCount: number;
  sessionCount: number;
}

export interface ChatSummaryStats {
  totalSessions: number;
  totalMessages: number;
  activeSessions: number;
}

export interface ChatTrendItem {
  hour: string;
  message_count: number;
  active_users: number;
  active_chats: number;
}

export interface MessageStats {
  total: number;
  success: number;
  failed: number;
  avgDuration: number;
  avgTtft?: number;
}

// ==================== Agent 响应类型 ====================

export interface AgentTextPart {
  type: 'text';
  text: string;
  state?: 'done' | 'streaming';
}

export interface AgentDynamicToolPart {
  type: 'dynamic-tool';
  toolName: string;
  toolCallId: string;
  state: 'pending' | 'running' | 'output-available' | 'error';
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
}

export type AgentMessagePart = AgentTextPart | AgentDynamicToolPart;

export interface AgentResponseMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePart[];
}

export interface RawHttpResponse {
  status: number;
  statusText: string;
  headers?: Record<string, string | undefined>;
  responseTime?: number;
}

export interface AgentInvocationRecord {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  isFallback: boolean;
  http?: RawHttpResponse;
}

// ==================== 消息处理记录 ====================

export type MessageRecordToolCallStatus = 'ok' | 'empty' | 'narrow' | 'error';

export interface MessageRecordToolCall {
  toolName: string;
  args: Record<string, unknown>;
  result?: unknown;
  /** 结果条数：数组 length 或 items/data/total/count 推断；无法推断时省略 */
  resultCount?: number;
  status?: MessageRecordToolCallStatus;
  durationMs?: number;
}

export interface MessageRecordAgentStep {
  stepIndex: number;
  text?: string;
  reasoning?: string;
  toolCalls: MessageRecordToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  durationMs?: number;
  finishReason?: string;
}

export type MessageRecordAnomalyFlag =
  | 'tool_loop'
  | 'tool_empty_result'
  | 'tool_narrow_result'
  | 'tool_chain_overlong'
  | 'no_tool_called';

export interface MessageRecordMemorySnapshot {
  currentStage: string | null;
  presentedJobIds: number[] | null;
  recommendedJobIds: number[] | null;
  sessionFacts: Record<string, unknown> | null;
  profileKeys: string[] | null;
}

export interface MessageRecord {
  messageId?: string;
  receivedAt: string | number;
  userId?: string;
  userName?: string;
  managerName?: string;
  chatId: string;
  messagePreview?: string;
  replyPreview?: string;
  totalDuration: number;
  aiDuration?: number;
  ttftMs?: number;
  sendDuration?: number;
  queueDuration?: number;
  prepDuration?: number;
  replySegments?: number;
  status: 'success' | 'failed' | 'failure' | 'processing' | 'timeout';
  error?: string;
  scenario?: string;
  tokenUsage?: number;
  isFallback?: boolean;
  fallbackSuccess?: boolean;
  agentInvocation?: AgentInvocationRecord;
  batchId?: string;
  /** 工具调用详情（取代旧的 tools string[]） */
  toolCalls?: MessageRecordToolCall[];
  /** 每步循环快照（text/reasoning/toolCalls/usage） */
  agentSteps?: MessageRecordAgentStep[];
  /** 异常信号标签，用于周报/巡检过滤 */
  anomalyFlags?: MessageRecordAnomalyFlag[];
  /** 本轮触发时的记忆上下文快照 */
  memorySnapshot?: MessageRecordMemorySnapshot;
}
