/**
 * 候选人黑名单 Hooks
 *
 * 独立业务域（candidate_blacklist 表）：拉黑后任一托管账号再次收到该候选人
 * 消息时发送飞书告警，并通过 user_hosting_status 永久暂停该会话的托管。
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import * as candidateBlacklistService from '@/api/services/candidate-blacklist.service';
import type { AddCandidateBlacklistParams } from '@/api/types/candidate-blacklist.types';

const LIVE_REFETCH_INTERVAL_MS = 3000;

/**
 * 获取候选人黑名单列表
 */
export function useCandidateBlacklist() {
  return useQuery({
    queryKey: ['candidate-blacklist'],
    queryFn: () => candidateBlacklistService.getCandidateBlacklist(),
    staleTime: 1000,
    refetchInterval: LIVE_REFETCH_INTERVAL_MS,
  });
}

/**
 * 拉黑候选人
 */
export function useAddCandidateToBlacklist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: AddCandidateBlacklistParams) =>
      candidateBlacklistService.addCandidateToBlacklist(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate-blacklist'] });
      toast.success('已拉黑，托管账号再次收到其消息时将告警并取消托管');
    },
    onError: () => {
      toast.error('拉黑失败，请重试');
    },
  });
}

/**
 * 移除候选人黑名单
 */
export function useRemoveCandidateFromBlacklist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { targetId: string }) =>
      candidateBlacklistService.removeCandidateFromBlacklist(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['candidate-blacklist'] });
      toast.success('已从黑名单移除（已暂停的会话需在用户列表手动恢复）');
    },
    onError: () => {
      toast.error('移除失败，请重试');
    },
  });
}
