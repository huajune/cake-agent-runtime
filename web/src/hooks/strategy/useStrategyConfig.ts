/**
 * 策略配置 React Query Hooks
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useSaveStatusStore } from '@/hooks/strategy/useSaveStatusStore';
import * as strategyService from '@/api/services/strategy.service';
import type {
  StrategyRoleSetting,
  StrategyPersona,
  StrategyStageGoals,
  StrategyRedLines,
} from '@/api/types/strategy.types';

const QUERY_KEY = ['strategy-config'];

/** 获取当前激活的完整策略配置 */
export function useStrategyConfig() {
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => strategyService.getStrategyConfig(),
    staleTime: 30000,
  });
}

/** 更新角色设定 */
export function useUpdateRoleSetting() {
  const queryClient = useQueryClient();
  const setStatus = useSaveStatusStore((s) => s.setStatus);
  return useMutation({
    mutationFn: (roleSetting: StrategyRoleSetting) =>
      strategyService.updateRoleSetting(roleSetting),
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

/** 更新人格配置 */
export function useUpdatePersona() {
  const queryClient = useQueryClient();
  const setStatus = useSaveStatusStore((s) => s.setStatus);
  return useMutation({
    mutationFn: (persona: StrategyPersona) => strategyService.updatePersona(persona),
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
    mutationFn: (stageGoals: StrategyStageGoals) =>
      strategyService.updateStageGoals(stageGoals),
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
    mutationFn: (redLines: StrategyRedLines) => strategyService.updateRedLines(redLines),
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

/** 获取 released 版本 */
export function useReleasedConfig() {
  return useQuery({
    queryKey: ['strategy-released'],
    queryFn: () => strategyService.getReleasedConfig(),
    staleTime: 30000,
  });
}

/** 发布策略 */
export function usePublishStrategy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (versionNote?: string) => strategyService.publishStrategy(versionNote),
    onSuccess: (result) => {
      queryClient.setQueryData(QUERY_KEY, result.config);
      queryClient.invalidateQueries({ queryKey: ['strategy-released'] });
      toast.success('策略已发布');
    },
    onError: () => {
      toast.error('发布失败，请重试');
    },
  });
}
