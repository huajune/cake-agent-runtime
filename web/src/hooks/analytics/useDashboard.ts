/**
 * Dashboard 相关 Hooks
 */

import { useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import * as analyticsService from '@/api/services/analytics.service';

export type {
  DashboardOverviewData,
  SystemMonitoringData,
  TrendsData,
} from '@/api/services/analytics.service';

function getOverviewRefetchInterval(timeRange: string): number {
  return timeRange === 'today' ? 15000 : 60000;
}

function getOverviewStaleTime(timeRange: string, autoRefresh: boolean): number {
  if (!autoRefresh) return 60000;
  return timeRange === 'today' ? 10000 : 60000;
}

/** @deprecated 使用 useDashboardOverview 替代 */
export function useDashboard(timeRange: string, autoRefresh = true, groups: string[] = []) {
  return useQuery({
    queryKey: ['dashboard', timeRange, groups],
    queryFn: () => analyticsService.getDashboard(timeRange, groups),
    refetchInterval: autoRefresh ? getOverviewRefetchInterval(timeRange) : false,
    staleTime: getOverviewStaleTime(timeRange, autoRefresh),
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}

export function useDashboardOverview(timeRange: string, autoRefresh = true, groups: string[] = []) {
  return useQuery({
    queryKey: ['dashboard-overview', timeRange, groups],
    queryFn: () => analyticsService.getDashboardOverview(timeRange, groups),
    refetchInterval: autoRefresh ? getOverviewRefetchInterval(timeRange) : false,
    staleTime: getOverviewStaleTime(timeRange, autoRefresh),
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });
}

export function usePrefetchDashboardOverview(enabled: boolean, groups: string[] = []) {
  const queryClient = useQueryClient();
  const groupKey = groups.join('|');

  useEffect(() => {
    if (!enabled || groups.length > 0) return;

    for (const range of ['week', 'month']) {
      queryClient.prefetchQuery({
        queryKey: ['dashboard-overview', range, groups],
        queryFn: () => analyticsService.getDashboardOverview(range, groups),
        staleTime: 60000,
      });
    }
    // groupKey keeps the effect stable while still responding to group content changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, groupKey, queryClient]);
}

export function useSystemMonitoring(autoRefresh = true) {
  return useQuery({
    queryKey: ['system-monitoring'],
    queryFn: () => analyticsService.getSystemMonitoring(),
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

export function useTrendsData(timeRange: string, autoRefresh = true) {
  return useQuery({
    queryKey: ['trends-data', timeRange],
    queryFn: () => analyticsService.getTrendsData(timeRange),
    refetchInterval: autoRefresh ? 10000 : false,
  });
}

export function useClearData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => analyticsService.clearData(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success('监控数据已清空');
    },
    onError: () => toast.error('清空数据失败'),
  });
}

export function useClearCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (type: 'metrics' | 'history' | 'agent' | 'all') =>
      analyticsService.clearCache(type),
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
    onError: () => toast.error('清除缓存失败'),
  });
}
