/**
 * 聊天会话相关 Hooks
 *
 * 包含聊天消息、会话列表、统计、趋势等查询功能
 */

import { useQuery } from '@tanstack/react-query';
import { api, unwrapResponse } from '../shared';

// ==================== 类型定义 ====================

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  messageType?: string;
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

// ==================== Query Hooks ====================

/**
 * 获取聊天消息列表（分页）
 */
export function useChatMessages(date?: string, page = 1, pageSize = 50) {
  return useQuery({
    queryKey: ['chat-messages', date, page, pageSize],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (date) params.set('date', date);
      params.set('page', String(page));
      params.set('pageSize', String(pageSize));
      const { data } = await api.get(`/analytics/chat-messages?${params.toString()}`);
      return unwrapResponse<ChatMessagesResponse>(data);
    },
  });
}

/**
 * 获取会话列表
 */
export function useChatSessions(days: number = 1, startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: ['chat-sessions', days, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (startDate) {
        params.set('startDate', startDate);
        if (endDate) params.set('endDate', endDate);
      } else {
        params.set('days', String(days));
      }
      const { data } = await api.get(`/analytics/chat-sessions?${params.toString()}`);
      return unwrapResponse<{ sessions: ChatSession[] }>(data);
    },
  });
}

/**
 * 获取每日聊天统计数据
 */
export function useChatDailyStats(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-daily-stats', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      const { data } = await api.get(`/analytics/chat-daily-stats?${params.toString()}`);
      return unwrapResponse<
        Array<{
          date: string;
          messageCount: number;
          sessionCount: number;
        }>
      >(data);
    },
  });
}

/**
 * 获取聊天汇总统计数据
 */
export function useChatSummaryStats(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-summary-stats', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      const { data } = await api.get(`/analytics/chat-summary-stats?${params.toString()}`);
      return unwrapResponse<{
        totalSessions: number;
        totalMessages: number;
        activeSessions: number;
      }>(data);
    },
  });
}

/**
 * 获取聊天会话列表（优化版，使用数据库聚合）
 */
export function useChatSessionsOptimized(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-sessions-optimized', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      const { data } = await api.get(`/analytics/chat-sessions-optimized?${params.toString()}`);
      const sessions = unwrapResponse<
        Array<{
          chatId: string;
          candidateName?: string;
          managerName?: string;
          messageCount: number;
          lastMessage?: string;
          lastTimestamp?: number;
          avatar?: string;
          contactType?: string;
        }>
      >(data);
      return { sessions };
    },
  });
}

/**
 * 获取聊天趋势（小时级统计）
 */
export function useChatTrend(days: number = 7) {
  return useQuery({
    queryKey: ['chat-trend', days],
    queryFn: async () => {
      const { data } = await api.get(`/analytics/chat-trend?days=${days}`);
      return unwrapResponse<
        Array<{
          hour: string;
          message_count: number;
          active_users: number;
          active_chats: number;
        }>
      >(data);
    },
  });
}

/**
 * 获取指定会话的消息列表
 */
export function useChatSessionMessages(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-session-messages', chatId],
    queryFn: async () => {
      if (!chatId) return { chatId: '', messages: [] };
      const { data } = await api.get(`/analytics/chat-sessions/${encodeURIComponent(chatId)}/messages`);
      return unwrapResponse<{ chatId: string; messages: ChatMessage[] }>(data);
    },
    enabled: !!chatId,
  });
}
