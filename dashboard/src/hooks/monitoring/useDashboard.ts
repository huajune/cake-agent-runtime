/**
 * Dashboard 相关 Hooks
 *
 * 包含 Dashboard 概览、系统监控、趋势数据等查询功能
 * 从 useMonitoring.ts 拆分而来（2025-12-16）
 */

import { useQuery } from '@tanstack/react-query';
import type { DashboardData } from '@/types/monitoring';
import { api, unwrapResponse } from './shared';

// ==================== 类型定义 ====================

// Dashboard 概览数据
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

// 系统监控数据
export interface SystemMonitoringData {
  queue: any;
  alertsSummary: any;
  alertTrend: any[];
}

// 趋势数据
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
    refetchInterval: autoRefresh ? 10000 : false, // 10秒刷新
  });
}
