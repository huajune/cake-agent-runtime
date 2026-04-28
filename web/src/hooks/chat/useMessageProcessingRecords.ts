/**
 * 消息处理记录相关 Hooks
 *
 * 包含消息统计、最慢消息、处理记录查询等功能
 */

import { useQuery } from '@tanstack/react-query';
import * as chatService from '@/api/services/chat.service';

// ==================== Query Hooks ====================

/**
 * 获取消息统计数据（聚合查询，轻量级）
 */
export function useMessageStats(options?: {
  startDate?: string;
  endDate?: string;
  userName?: string;
  managerNames?: string[];
}) {
  return useQuery({
    queryKey: ['message-stats', options],
    queryFn: () => chatService.getMessageStats(options),
    staleTime: 10000,
  });
}

/**
 * 获取最慢消息 Top N
 */
export function useSlowestMessages(options?: {
  startDate?: string;
  endDate?: string;
  userName?: string;
  managerNames?: string[];
  limit?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['slowest-messages', options],
    queryFn: () => chatService.getSlowestMessages(options),
    enabled: options?.enabled ?? true,
    staleTime: 10000,
  });
}

/**
 * 获取消息处理记录列表（支持分页和筛选）
 */
export function useMessageProcessingRecords(options?: {
  startDate?: string;
  endDate?: string;
  status?: 'processing' | 'success' | 'failure' | 'timeout';
  chatId?: string;
  userName?: string;
  managerNames?: string[];
  limit?: number;
  offset?: number;
  enabled?: boolean;
}) {
  return useQuery({
    queryKey: ['message-processing-records', options],
    queryFn: () => chatService.getMessageProcessingRecords(options),
    enabled: options?.enabled ?? true,
    staleTime: 10000,
  });
}

/**
 * 获取单条消息处理记录详情
 */
export function useMessageProcessingRecordDetail(messageId: string | null) {
  return useQuery({
    queryKey: ['message-processing-record-detail', messageId],
    queryFn: () => chatService.getMessageProcessingRecordDetail(messageId!),
    enabled: !!messageId,
    staleTime: 60000,
  });
}
