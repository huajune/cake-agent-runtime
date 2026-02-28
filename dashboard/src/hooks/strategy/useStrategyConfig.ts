/**
 * 策略配置 React Query Hooks
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { api, unwrapResponse } from '@/hooks/monitoring/shared';
import { useSaveStatusStore } from '@/hooks/strategy/useSaveStatusStore';
import type {
  StrategyConfigRecord,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from '@/types/strategy';

const QUERY_KEY = ['strategy-config'];

/** 获取当前激活的完整策略配置 */
export function useStrategyConfig() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const { data } = await api.get('/agent/strategy');
      return unwrapResponse<StrategyConfigRecord>(data);
    },
    staleTime: 30000,
  });
}

/** 更新人格配置 */
export function useUpdatePersona() {
  const queryClient = useQueryClient();
  const setStatus = useSaveStatusStore((s) => s.setStatus);
  return useMutation({
    mutationFn: async (persona: StrategyPersona) => {
      const { data } = await api.post('/agent/strategy/persona', persona);
      return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
    },
    onMutate: () => setStatus('saving'),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result.config);
      setStatus('saved');
    },
    onError: () => {
      setStatus('error');
      toast.error('保存失败，请重试');
    },
  });
}

/** 更新阶段目标 */
export function useUpdateStageGoals() {
  const queryClient = useQueryClient();
  const setStatus = useSaveStatusStore((s) => s.setStatus);
  return useMutation({
    mutationFn: async (stageGoals: StrategyStageGoals) => {
      const { data } = await api.post('/agent/strategy/stage-goals', stageGoals);
      return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
    },
    onMutate: () => setStatus('saving'),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result.config);
      setStatus('saved');
    },
    onError: () => {
      setStatus('error');
      toast.error('保存失败，请重试');
    },
  });
}

/** 更新红线规则 */
export function useUpdateRedLines() {
  const queryClient = useQueryClient();
  const setStatus = useSaveStatusStore((s) => s.setStatus);
  return useMutation({
    mutationFn: async (redLines: StrategyRedLines) => {
      const { data } = await api.post('/agent/strategy/red-lines', redLines);
      return unwrapResponse<{ config: StrategyConfigRecord; message: string }>(data);
    },
    onMutate: () => setStatus('saving'),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result.config);
      setStatus('saved');
    },
    onError: () => {
      setStatus('error');
      toast.error('保存失败，请重试');
    },
  });
}
