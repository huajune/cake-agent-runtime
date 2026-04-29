/**
 * 系统配置相关 Hooks
 *
 * 包含 AI 回复开关、消息聚合开关、黑名单、Agent 配置等功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { WorkerStatus } from '@/api/types/monitoring.types';
import type { AgentReplyConfig } from '@/api/types/config.types';
import * as agentService from '@/api/services/agent.service';
import * as monitoringService from '@/api/services/monitoring.service';
import * as configService from '@/api/services/config.service';

export type { AvailableModelsResponse, ConfiguredToolsResponse } from '@/api/services/agent.service';

const LIVE_CONFIG_REFETCH_INTERVAL_MS = 3000;

// ==================== Query Hooks ====================

/**
 * 获取可用的 AI 模型列表
 */
export function useAvailableModels() {
  return useQuery({
    queryKey: ['available-models'],
    queryFn: () => agentService.getAvailableModels(),
    staleTime: 60000,
  });
}

/**
 * 获取配置的工具列表
 */
export function useConfiguredTools() {
  return useQuery({
    queryKey: ['configured-tools'],
    queryFn: () => agentService.getConfiguredTools(),
    staleTime: 60000,
  });
}

/**
 * 获取 AI 回复状态
 */
export function useAiReplyStatus(autoRefresh = true) {
  return useQuery({
    queryKey: ['ai-reply-status'],
    queryFn: () => monitoringService.getAiReplyStatus(),
    staleTime: 1000,
    refetchInterval: autoRefresh ? LIVE_CONFIG_REFETCH_INTERVAL_MS : false,
  });
}

/**
 * 获取黑名单列表
 */
export function useBlacklist() {
  return useQuery({
    queryKey: ['blacklist'],
    queryFn: () => configService.getBlacklist(),
    staleTime: 1000,
    refetchInterval: LIVE_CONFIG_REFETCH_INTERVAL_MS,
  });
}

/**
 * 获取 Agent 回复策略配置
 */
export function useAgentReplyConfig() {
  return useQuery({
    queryKey: ['agent-reply-config'],
    queryFn: () => configService.getAgentReplyConfig(),
    staleTime: 1000,
    refetchInterval: LIVE_CONFIG_REFETCH_INTERVAL_MS,
  });
}

// ==================== Mutation Hooks ====================

/**
 * 切换 AI 回复 - 使用乐观更新让 UI 立即响应
 */
export function useToggleAiReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => monitoringService.toggleAiReply(enabled),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: ['ai-reply-status'] });
      const previousStatus = queryClient.getQueryData<{ enabled: boolean }>(['ai-reply-status']);
      queryClient.setQueryData(['ai-reply-status'], { enabled });
      return { previousStatus, enabled };
    },
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? '智能回复已启用' : '智能回复已禁用');
    },
    onError: (_err, _enabled, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['ai-reply-status'], context.previousStatus);
      }
      toast.error('操作失败，请重试');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['ai-reply-status'] });
    },
  });
}

/**
 * 切换消息聚合开关 - 使用乐观更新让 UI 立即响应
 */
export function useToggleMessageMerge() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => monitoringService.toggleMessageMerge(enabled),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey: ['worker-status'] });
      const previousStatus = queryClient.getQueryData<WorkerStatus>(['worker-status']);
      if (previousStatus) {
        queryClient.setQueryData<WorkerStatus>(['worker-status'], {
          ...previousStatus,
          messageMergeEnabled: enabled,
        });
      }
      return { previousStatus, enabled };
    },
    onSuccess: (_data, enabled) => {
      toast.success(enabled ? '消息聚合已启用' : '消息聚合已禁用');
    },
    onError: (_err, _enabled, context) => {
      if (context?.previousStatus) {
        queryClient.setQueryData(['worker-status'], context.previousStatus);
      }
      toast.error('操作失败，请重试');
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['worker-status'] });
    },
  });
}

/**
 * 添加黑名单
 */
export function useAddToBlacklist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; type: 'chatId' | 'groupId' }) =>
      configService.addToBlacklist(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blacklist'] });
      toast.success('已添加到黑名单');
    },
    onError: () => {
      toast.error('添加失败，请重试');
    },
  });
}

/**
 * 删除黑名单
 */
export function useRemoveFromBlacklist() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; type: 'chatId' | 'groupId' }) =>
      configService.removeFromBlacklist(params),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['blacklist'] });
      toast.success('已从黑名单移除');
    },
    onError: () => {
      toast.error('移除失败，请重试');
    },
  });
}

/**
 * 更新 Agent 回复策略配置
 */
export function useUpdateAgentReplyConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<AgentReplyConfig>) =>
      configService.updateAgentReplyConfig(config),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agent-reply-config'] });
      toast.success(data.message || '配置已更新');
    },
    onError: (error: Error) => {
      toast.error(error.message || '更新配置失败');
    },
  });
}

/**
 * 重置 Agent 回复策略配置为默认值
 */
export function useResetAgentReplyConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => configService.resetAgentReplyConfig(),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agent-reply-config'] });
      toast.success(data.message || '配置已重置');
    },
    onError: () => {
      toast.error('重置配置失败');
    },
  });
}
