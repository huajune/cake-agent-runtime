/**
 * 监控指标相关 Hooks
 *
 * 包含系统指标、健康状态、最近消息等查询功能
 */

import { useQuery } from '@tanstack/react-query';
import type { MetricsData, HealthStatus, MessageRecord, SystemInfo } from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== Query Hooks ====================

/**
 * Metrics 数据
 */
export function useMetrics(autoRefresh = true) {
  return useQuery({
    queryKey: ['metrics'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/metrics');
      return unwrapResponse<MetricsData>(data);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * 健康状态
 */
export function useHealthStatus(autoRefresh = true) {
  return useQuery({
    queryKey: ['health-status'],
    queryFn: async () => {
      const { data } = await api.get('/agent/health');
      return unwrapResponse<HealthStatus>(data);
    },
    refetchInterval: autoRefresh ? 60000 : false,
  });
}

/**
 * 最近消息
 */
export function useRecentMessages() {
  return useQuery({
    queryKey: ['recent-messages'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/recent-messages');
      return unwrapResponse<MessageRecord[]>(data);
    },
    refetchInterval: 5000,
  });
}

/**
 * 系统信息
 */
export function useSystemInfo() {
  return useQuery({
    queryKey: ['systemInfo'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/system');
      return unwrapResponse(data) as SystemInfo;
    },
    refetchInterval: 30000,
  });
}
