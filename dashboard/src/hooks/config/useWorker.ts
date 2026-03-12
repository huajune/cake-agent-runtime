/**
 * Worker 并发管理相关 Hooks
 *
 * 包含 Worker 状态、小组列表、并发数设置等功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { WorkerStatus } from '@/api/types/monitoring.types';
import * as monitoringService from '@/api/services/monitoring.service';

export type { WorkerConcurrencyResponse, GroupInfo } from '@/api/services/monitoring.service';

// ==================== Query Hooks ====================

/**
 * 获取 Worker 状态
 */
export function useWorkerStatus(autoRefresh = true) {
  return useQuery({
    queryKey: ['worker-status'],
    queryFn: () => monitoringService.getWorkerStatus(),
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * 获取小组列表
 */
export function useGroupList() {
  return useQuery({
    queryKey: ['group-list'],
    queryFn: () => monitoringService.getGroupList(),
    staleTime: 60000,
  });
}

// ==================== Mutation Hooks ====================

/**
 * 设置 Worker 并发数
 */
export function useSetWorkerConcurrency() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (concurrency: number) => monitoringService.setWorkerConcurrency(concurrency),
    onMutate: async (concurrency) => {
      await queryClient.cancelQueries({ queryKey: ['worker-status'] });
      const previousStatus = queryClient.getQueryData<WorkerStatus>(['worker-status']);
      if (previousStatus) {
        queryClient.setQueryData<WorkerStatus>(['worker-status'], {
          ...previousStatus,
          concurrency,
        });
      }
      return { previousStatus };
    },
    onSuccess: (data) => {
      if (data.success) {
        toast.success(data.message || '并发数已更新');
      } else {
        toast.error(data.message || '更新失败');
      }
    },
    onError: (_err, _concurrency, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['worker-status'], context.previousStatus);
      }
      toast.error('设置并发数失败');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}
