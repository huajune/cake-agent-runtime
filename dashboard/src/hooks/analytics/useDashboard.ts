/**
 * Dashboard 相关 Hooks
 *
 * 包含 Dashboard 概览、系统监控、趋势数据等查询功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { DashboardData } from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== 类型定义 ====================

export interface DashboardOverviewData {
  timeRange: string;
  overview: any;
  overviewDelta: any;
  dailyTrend: any[];
  tokenTrend: any[];
  businessTrend: any[];
  responseTrend: any[];
  business: any;
  businessDelta: any;
  fallback: any;
  fallbackDelta: any;
}

export interface SystemMonitoringData {
  queue: any;
  alertsSummary: any;
  alertTrend: any[];
}

export interface TrendsData {
  dailyTrend: any;
  responseTrend: any[];
  alertTrend: any[];
  businessTrend: any[];
}

// ==================== Query Hooks ====================

/**
 * Dashboard 数据（已废弃，建议使用 useDashboardOverview）
 * @deprecated 使用 useDashboardOverview 或 useSystemMonitoring 替代
 */
export function useDashboard(timeRange: string, autoRefresh = true) {
  return useQuery({
    queryKey: ['dashboard', timeRange],
    queryFn: async () => {
      const { data } = await api.get(`/analytics/dashboard?range=${timeRange}`);
      return unwrapResponse<DashboardData>(data);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * Dashboard 概览数据（轻量级，推荐使用）
 */
export function useDashboardOverview(timeRange: string, autoRefresh = true) {
  return useQuery({
    queryKey: ['dashboard-overview', timeRange],
    queryFn: async () => {
      const { data } = await api.get(`/analytics/dashboard/overview?range=${timeRange}`);
      return unwrapResponse<DashboardOverviewData>(data);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * System 监控数据（轻量级）
 */
export function useSystemMonitoring(autoRefresh = true) {
  return useQuery({
    queryKey: ['system-monitoring'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/dashboard/system');
      return unwrapResponse<SystemMonitoringData>(data);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * 趋势数据（独立接口）
 */
export function useTrendsData(timeRange: string, autoRefresh = true) {
  return useQuery({
    queryKey: ['trends-data', timeRange],
    queryFn: async () => {
      const { data } = await api.get(`/analytics/stats/trends?range=${timeRange}`);
      return unwrapResponse<TrendsData>(data);
    },
    refetchInterval: autoRefresh ? 10000 : false,
  });
}

// ==================== Mutation Hooks ====================

/**
 * 清空监控数据
 */
export function useClearData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/analytics/clear');
      return unwrapResponse(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success('监控数据已清空');
    },
    onError: () => {
      toast.error('清空数据失败');
    },
  });
}

/**
 * 清除缓存
 */
export function useClearCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (type: 'metrics' | 'history' | 'agent' | 'all') => {
      const { data } = await api.post(`/analytics/cache/clear?type=${type}`);
      return unwrapResponse(data);
    },
    onSuccess: (_data, type) => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      const typeLabels: Record<string, string> = {
        metrics: '指标缓存',
        history: '历史缓存',
        agent: 'Agent 缓存',
        all: '所有缓存',
      };
      toast.success(`${typeLabels[type] || type} 已清除`);
    },
    onError: () => {
      toast.error('清除缓存失败');
    },
  });
}
