/**
 * Worker 并发管理相关 Hooks
 *
 * 包含 Worker 状态、小组列表、并发数设置等功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { WorkerStatus } from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== 类型定义 ====================

export interface WorkerConcurrencyResponse {
  success: boolean;
  message: string;
  concurrency: number;
}

export interface GroupInfo {
  id: string;
  name: string;
  description: string;
}

// ==================== Query Hooks ====================

/**
 * 获取 Worker 状态
 */
export function useWorkerStatus(autoRefresh = true) {
  return useQuery({
    queryKey: ['worker-status'],
    queryFn: async () => {
      const { data } = await api.get('/monitoring/worker-status');
      return unwrapResponse<WorkerStatus>(data);
    },
    refetchInterval: autoRefresh ? 5000 : false,
  });
}

/**
 * 获取小组列表
 */
export function useGroupList() {
  return useQuery({
    queryKey: ['group-list'],
    queryFn: async () => {
      const token = import.meta.env.VITE_ENTERPRISE_TOKEN || '9eaebbf614104879b81c2da7c41819bd';
      const { data } = await api.get(`/group/list?token=${token}`);
      const groups = unwrapResponse<GroupInfo[]>(data);
      return groups || [];
    },
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
    mutationFn: async (concurrency: number) => {
      const { data } = await api.post('/monitoring/worker-concurrency', { concurrency });
      return unwrapResponse<WorkerConcurrencyResponse>(data);
    },
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
