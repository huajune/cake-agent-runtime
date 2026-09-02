/**
 * 聊天会话相关 Hooks
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import * as chatService from '@/api/services/chat.service';

export type {
  ChatMessage,
  ChatMessagesResponse,
  ChatSession,
  ChatSessionCursor,
  ChatSessionPage,
} from '@/api/services/chat.service';
import type { ChatSessionCursor } from '@/api/services/chat.service';

export function useChatMessages(date?: string, page = 1, pageSize = 50) {
  return useQuery({
    queryKey: ['chat-messages', date, page, pageSize],
    queryFn: () => chatService.getChatMessages(date, page, pageSize),
  });
}

export function useChatSessions(days: number = 1, startDate?: string, endDate?: string) {
  return useQuery({
    queryKey: ['chat-sessions', days, startDate, endDate],
    queryFn: () => chatService.getChatSessions(days, startDate, endDate),
  });
}

export function useChatDailyStats(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-daily-stats', startDate, endDate],
    queryFn: () => chatService.getChatDailyStats(startDate, endDate),
  });
}

/** 业务口径每日趋势（永久表），供消息趋势面板；startDate 为 undefined 表示「全部」（后端取安全起点 2026-06-01）。 */
export function useChatBusinessDailyTrend(startDate: string | undefined, endDate: string) {
  return useQuery({
    queryKey: ['chat-business-daily-trend', startDate ?? 'all', endDate],
    queryFn: () => chatService.getChatBusinessDailyTrend(startDate, endDate),
  });
}

export function useChatSummaryStats(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-summary-stats', startDate, endDate],
    queryFn: () => chatService.getChatSummaryStats(startDate, endDate),
  });
}

/** 会话列表页大小：一屏够用，单页往返稳定在亚秒级。 */
export const CHAT_SESSION_PAGE_SIZE = 200;

/**
 * 会话列表（游标分页 + 服务端搜索）。
 *
 * 用游标而非 offset：列表按最后消息时间倒序，新消息会把会话顶到列表头，
 * offset 会整体漂移导致翻页重复/漏项。
 *
 * 搜索下推到服务端，命中范围是整个时间窗，而不只是已加载的那几页。
 */
export function useChatSessionsOptimized(
  startDate: string,
  endDate: string,
  enabled = true,
  search = '',
) {
  return useInfiniteQuery({
    queryKey: ['chat-sessions-optimized', startDate, endDate, search],
    queryFn: ({ pageParam }) =>
      chatService.getChatSessionsOptimized({
        startDate,
        endDate,
        limit: CHAT_SESSION_PAGE_SIZE,
        search,
        cursor: pageParam,
      }),
    initialPageParam: null as ChatSessionCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled,
  });
}

export function useChatTrend(days: number = 7) {
  return useQuery({
    queryKey: ['chat-trend', days],
    queryFn: () => chatService.getChatTrend(days),
  });
}

export function useChatSessionMessages(chatId: string | null) {
  return useQuery({
    queryKey: ['chat-session-messages', chatId],
    queryFn: () => (chatId ? chatService.getChatSessionMessages(chatId) : { chatId: '', messages: [] }),
    enabled: !!chatId,
  });
}
