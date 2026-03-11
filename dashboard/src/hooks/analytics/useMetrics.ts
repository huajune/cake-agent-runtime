/**
 * 监控指标相关 Hooks
 *
 * 包含系统指标、健康状态、最近消息等查询功能
 */

import { useQuery } from '@tanstack/react-query';
import * as analyticsService from '@/api/services/analytics.service';
import * as agentService from '@/api/services/agent.service';

// ==================== Query Hooks ====================

/**
 * Metrics 数据
 */
export function useMetrics(autoRefresh = true) {
  return useQuery({
    queryKey: ['metrics'],
    queryFn: () => analyticsService.getMetrics(),
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * 健康状态
 */
export function useHealthStatus(autoRefresh = true) {
  return useQuery({
    queryKey: ['health-status'],
    queryFn: () => agentService.getHealthStatus(),
    refetchInterval: autoRefresh ? 60000 : false,
  });
}

/**
 * 最近消息
 */
export function useRecentMessages() {
  return useQuery({
    queryKey: ['recent-messages'],
    queryFn: () => analyticsService.getRecentMessages(),
    refetchInterval: 5000,
  });
}

/**
 * 系统信息
 */
export function useSystemInfo() {
  return useQuery({
    queryKey: ['systemInfo'],
    queryFn: () => analyticsService.getSystemInfo(),
    refetchInterval: 30000,
  });
}
