/**
 * 消息处理记录相关 Hooks
 *
 * 包含消息统计、最慢消息、处理记录查询等功能
 */

import { useQuery } from '@tanstack/react-query';
import type { MessageRecord } from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== Query Hooks ====================

/**
 * 获取消息统计数据（聚合查询，轻量级）
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
    refetchInterval: 5000,
  });
}

/**
 * 获取最慢消息 Top N
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
    refetchInterval: 5000,
  });
}

/**
 * 获取消息处理记录列表（支持分页和筛选）
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
 * 获取单条消息处理记录详情
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
    staleTime: 60000,
  });
}
