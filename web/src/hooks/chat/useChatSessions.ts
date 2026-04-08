/**
 * 聊天会话相关 Hooks
 */

import { useQuery } from '@tanstack/react-query';
import * as chatService from '@/api/services/chat.service';

export type { ChatMessage, ChatMessagesResponse, ChatSession } from '@/api/services/chat.service';

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

export function useChatSummaryStats(startDate: string, endDate: string) {
  return useQuery({
    queryKey: ['chat-summary-stats', startDate, endDate],
    queryFn: () => chatService.getChatSummaryStats(startDate, endDate),
  });
}

export function useChatSessionsOptimized(startDate: string, endDate: string, enabled = true) {
  return useQuery({
    queryKey: ['chat-sessions-optimized', startDate, endDate],
    queryFn: () => chatService.getChatSessionsOptimized(startDate, endDate),
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
