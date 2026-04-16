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
  tools?: string[];
  tokenUsage?: number;
  isFallback?: boolean;
  fallbackSuccess?: boolean;
  agentInvocation?: AgentInvocationRecord;
  batchId?: string;
}
