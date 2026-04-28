import type { MessageRecord } from '../types/chat.types';
import type {
  ChatMessage,
  ChatMessagesResponse,
  ChatSession,
  ChatDailyStatsItem,
  ChatSummaryStats,
  ChatTrendItem,
  MessageStats,
} from '../types/chat.types';
import { api, unwrapResponse } from '../client';

export type {
  ChatMessage,
  ChatMessagesResponse,
  ChatSession,
  ChatDailyStatsItem,
  ChatSummaryStats,
  ChatTrendItem,
  MessageStats,
} from '../types/chat.types';

// ==================== 聊天会话 API ====================

export async function getChatMessages(date?: string, page = 1, pageSize = 50) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  const { data } = await api.get(`/analytics/chat-messages?${params.toString()}`);
  return unwrapResponse<ChatMessagesResponse>(data);
}

export async function getChatSessions(days: number = 1, startDate?: string, endDate?: string) {
  const params = new URLSearchParams();
  if (startDate) {
    params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
  } else {
    params.set('days', String(days));
  }
  const { data } = await api.get(`/analytics/chat-sessions?${params.toString()}`);
  return unwrapResponse<{ sessions: ChatSession[] }>(data);
}

export async function getChatDailyStats(startDate: string, endDate: string) {
  const params = new URLSearchParams({ startDate, endDate });
  const { data } = await api.get(`/analytics/chat-daily-stats?${params.toString()}`);
  return unwrapResponse<ChatDailyStatsItem[]>(data);
}

export async function getChatSummaryStats(startDate: string, endDate: string) {
  const params = new URLSearchParams({ startDate, endDate });
  const { data } = await api.get(`/analytics/chat-summary-stats?${params.toString()}`);
  return unwrapResponse<ChatSummaryStats>(data);
}

export async function getChatSessionsOptimized(startDate: string, endDate: string) {
  const params = new URLSearchParams({ startDate, endDate });
  const { data } = await api.get(`/analytics/chat-sessions-optimized?${params.toString()}`);
  const sessions = unwrapResponse<ChatSession[]>(data);
  return { sessions };
}

export async function getChatTrend(days: number = 7) {
  const { data } = await api.get(`/analytics/chat-trend?days=${days}`);
  return unwrapResponse<ChatTrendItem[]>(data);
}

export async function getChatSessionMessages(chatId: string) {
  const { data } = await api.get(`/analytics/chat-sessions/${encodeURIComponent(chatId)}/messages`);
  return unwrapResponse<{ chatId: string; messages: ChatMessage[] }>(data);
}

// ==================== 消息处理记录 API ====================

function appendManagerNameParams(params: URLSearchParams, managerNames?: string[]) {
  for (const managerName of managerNames || []) {
    const trimmed = managerName.trim();
    if (trimmed) params.append('managerName', trimmed);
  }
}

export async function getMessageStats(options?: {
  startDate?: string;
  endDate?: string;
  userName?: string;
  managerNames?: string[];
}) {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.userName) params.set('userName', options.userName);
  appendManagerNameParams(params, options?.managerNames);
  const { data } = await api.get(`/analytics/message-stats?${params.toString()}`);
  return unwrapResponse<MessageStats>(data);
}

export async function getSlowestMessages(options?: {
  startDate?: string;
  endDate?: string;
  userName?: string;
  managerNames?: string[];
  limit?: number;
}) {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.userName) params.set('userName', options.userName);
  appendManagerNameParams(params, options?.managerNames);
  if (options?.limit) params.set('limit', String(options.limit));
  const { data } = await api.get(`/analytics/slowest-messages?${params.toString()}`);
  return unwrapResponse<MessageRecord[]>(data);
}

export async function getMessageProcessingRecords(options?: {
  startDate?: string;
  endDate?: string;
  status?: 'processing' | 'success' | 'failure' | 'timeout';
  chatId?: string;
  userName?: string;
  managerNames?: string[];
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (options?.startDate) params.set('startDate', options.startDate);
  if (options?.endDate) params.set('endDate', options.endDate);
  if (options?.status) params.set('status', options.status);
  if (options?.chatId) params.set('chatId', options.chatId);
  if (options?.userName) params.set('userName', options.userName);
  appendManagerNameParams(params, options?.managerNames);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const { data } = await api.get(`/analytics/message-processing-records?${params.toString()}`);
  return unwrapResponse<MessageRecord[]>(data);
}

export async function getMessageProcessingRecordDetail(messageId: string) {
  const { data } = await api.get(
    `/analytics/message-processing-records/${encodeURIComponent(messageId)}`,
  );
  return unwrapResponse<MessageRecord>(data);
}
