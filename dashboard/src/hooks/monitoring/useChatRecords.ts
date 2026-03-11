/**
 * 聊天记录相关 Hooks
 *
 * 包含聊天消息、会话、统计等查询功能
 * 从 useMonitoring.ts 拆分而来（2025-12-16）
 */

import { useQuery } from '@tanstack/react-query';
import type { MessageRecord } from '@/types/monitoring';
import { api, unwrapResponse } from './shared';

// ==================== 类型定义 ====================

export interface ChatMessage {
  id: string;
  chatId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  // v1.3 新增字段
  messageType?: string; // 消息类型：TEXT, IMAGE, VOICE, FILE 等
  source?: string; // 消息来源：MOBILE_PUSH, AI_REPLY 等
  contactType?: string; // 客户类型：PERSONAL_WECHAT, ENTERPRISE_WECHAT 等
  isSelf?: boolean; // 是否托管账号自己发送
  avatar?: string; // 用户头像URL
  externalUserId?: string; // 企微外部用户ID
}

export interface ChatMessagesResponse {
  messages: ChatMessage[];
  total: number;
  page: number;
  pageSize: number;
}

// 会话信息
// v1.3: 新增 avatar, contactType 字段
export interface ChatSession {
  chatId: string;
  candidateName?: string;
  managerName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
  // v1.3 新增字段
  avatar?: string; // 用户头像URL
  contactType?: string; // 客户类型
}

// ==================== 聊天消息查询 ====================

/**
 * 获取聊天消息列表（分页）
 * @param date - 日期筛选 (YYYY-MM-DD)
 * @param page - 页码
 * @param pageSize - 每页数量
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

// ==================== 聊天会话查询 ====================

/**
 * 获取会话列表
 * v1.4: 支持精确的 startDate/endDate 时间范围筛选
 * @param days - 最近天数（当未指定 startDate 时使用）
 * @param startDate - 开始日期 (YYYY-MM-DD)
 * @param endDate - 结束日期 (YYYY-MM-DD)
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
 * 获取每日聊天统计数据（数据库聚合查询，性能优化版本）
 * v1.5: 用于趋势图表展示
 * @param startDate - 开始日期 (YYYY-MM-DD)
 * @param endDate - 结束日期 (YYYY-MM-DD)
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
 * 获取聊天汇总统计数据（数据库聚合查询，性能优化版本）
 * v1.5: 用于顶部统计栏展示
 * @param startDate - 开始日期 (YYYY-MM-DD)
 * @param endDate - 结束日期 (YYYY-MM-DD)
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
 * v1.5: 数据库层面聚合，性能优化
 * @param startDate - 开始日期 (YYYY-MM-DD)
 * @param endDate - 结束日期 (YYYY-MM-DD)
 */
export function useChatSessionsOptimized(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-sessions-optimized', startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams();
      params.set('startDate', startDate);
      params.set('endDate', endDate);
      const { data } = await api.get(`/analytics/chat-sessions-optimized?${params.toString()}`);
      // API 返回数组，包装成 { sessions: [...] } 格式
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
 * @param days - 最近天数
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
 * @param chatId - 会话ID
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

// ==================== 消息处理记录（持久化）====================

/**
 * 获取消息统计数据（聚合查询，轻量级）
 * @param options.startDate - 开始日期 (YYYY-MM-DD)
 * @param options.endDate - 结束日期 (YYYY-MM-DD)
 */
export function useMessageStats(options?: { startDate?: string; endDate?: string }) {
  return useQuery({
    queryKey: ['message-stats', options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.startDate) params.set('startDate', options.startDate);
      if (options?.endDate) params.set('endDate', options.endDate);

      const { data } = await api.get(`/analytics/message-stats?${params.toString()}`);
      return unwrapResponse<{
        total: number;
        success: number;
        failed: number;
        avgDuration: number;
      }>(data);
    },
    refetchInterval: 5000, // 每 5 秒刷新
  });
}

/**
 * 获取最慢消息 Top N（数据库排序，轻量级）
 * @param options.startDate - 开始日期 (YYYY-MM-DD)
 * @param options.endDate - 结束日期 (YYYY-MM-DD)
 * @param options.limit - 返回数量限制
 */
export function useSlowestMessages(options?: {
  startDate?: string;
  endDate?: string;
  limit?: number;
}) {
  return useQuery({
    queryKey: ['slowest-messages', options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.startDate) params.set('startDate', options.startDate);
      if (options?.endDate) params.set('endDate', options.endDate);
      if (options?.limit) params.set('limit', String(options.limit));

      const { data } = await api.get(`/analytics/slowest-messages?${params.toString()}`);
      return unwrapResponse<MessageRecord[]>(data);
    },
    refetchInterval: 5000, // 每 5 秒刷新
  });
}

/**
 * 获取消息处理记录列表（支持分页和筛选）
 * @param options.startDate - 开始日期 (YYYY-MM-DD)
 * @param options.endDate - 结束日期 (YYYY-MM-DD)
 * @param options.status - 状态筛选
 * @param options.chatId - 会话ID筛选
 * @param options.userName - 用户昵称模糊搜索
 * @param options.limit - 返回数量限制
 * @param options.offset - 偏移量（分页）
 */
export function useMessageProcessingRecords(options?: {
  startDate?: string;
  endDate?: string;
  status?: 'processing' | 'success' | 'failure';
  chatId?: string;
  userName?: string;
  limit?: number;
  offset?: number;
}) {
  return useQuery({
    queryKey: ['message-processing-records', options],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (options?.startDate) params.set('startDate', options.startDate);
      if (options?.endDate) params.set('endDate', options.endDate);
      if (options?.status) params.set('status', options.status);
      if (options?.chatId) params.set('chatId', options.chatId);
      if (options?.userName) params.set('userName', options.userName);
      if (options?.limit) params.set('limit', String(options.limit));
      if (options?.offset) params.set('offset', String(options.offset));

      const { data } = await api.get(`/analytics/message-processing-records?${params.toString()}`);
      return unwrapResponse<MessageRecord[]>(data);
    },
  });
}

/**
 * 获取单条消息处理记录详情（按需加载，包含完整的 agentInvocation）
 * @param messageId - 消息ID
 */
export function useMessageProcessingRecordDetail(messageId: string | null) {
  return useQuery({
    queryKey: ['message-processing-record-detail', messageId],
    queryFn: async () => {
      if (!messageId) return null;
      const { data } = await api.get(`/analytics/message-processing-records/${encodeURIComponent(messageId)}`);
      return unwrapResponse<MessageRecord>(data);
    },
    enabled: !!messageId,
    staleTime: 60000, // 1 分钟内不重新请求
  });
}
