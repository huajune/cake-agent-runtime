/**
 * 系统配置相关 Hooks
 *
 * 包含 AI 回复开关、消息聚合开关、黑名单、Agent 配置等功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type {
  BlacklistData,
  WorkerStatus,
  AgentReplyConfig,
  AgentReplyConfigResponse,
} from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== 类型定义 ====================

export interface AvailableModelsResponse {
  availableModels: string[];
  defaultModel: string;
  defaultModelAvailable: boolean;
  lastRefreshTime: string;
}

export interface ConfiguredToolsResponse {
  configuredTools: string[];
  count: number;
  allAvailable: boolean;
  lastRefreshTime: string;
}

// ==================== Query Hooks ====================

/**
 * 获取可用的 AI 模型列表
 */
export function useAvailableModels() {
  return useQuery({
    queryKey: ['available-models'],
    queryFn: async () => {
      const { data } = await api.get('/agent/available-models');
      return unwrapResponse<AvailableModelsResponse>(data);
    },
    staleTime: 60000,
  });
}

/**
 * 获取配置的工具列表
 */
export function useConfiguredTools() {
  return useQuery({
    queryKey: ['configured-tools'],
    queryFn: async () => {
      const { data } = await api.get('/agent/configured-tools');
      return unwrapResponse<ConfiguredToolsResponse>(data);
    },
    staleTime: 60000,
  });
}

/**
 * 获取 AI 回复状态
 */
export function useAiReplyStatus() {
  return useQuery({
    queryKey: ['ai-reply-status'],
    queryFn: async () => {
      const { data } = await api.get('/monitoring/ai-reply-status');
      return unwrapResponse<{ enabled: boolean }>(data);
    },
  });
}

/**
 * 获取黑名单列表
 */
export function useBlacklist() {
  return useQuery({
    queryKey: ['blacklist'],
    queryFn: async () => {
      const { data } = await api.get('/config/blacklist');
      return unwrapResponse<BlacklistData>(data);
    },
  });
}

/**
 * 获取 Agent 回复策略配置
 */
export function useAgentReplyConfig() {
  return useQuery({
    queryKey: ['agent-reply-config'],
    queryFn: async () => {
      const { data } = await api.get('/config/agent-config');
      return unwrapResponse<AgentReplyConfigResponse>(data);
    },
  });
}

// ==================== Mutation Hooks ====================

/**
 * 切换 AI 回复 - 使用乐观更新让 UI 立即响应
 */
export function useToggleAiReply() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (enabled: boolean) => {
      const { data } = await api.post('/monitoring/toggle-ai-reply', { enabled });
      return unwrapResponse<{ enabled: boolean; message: string }>(data);
    },
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
    mutationFn: async (enabled: boolean) => {
      const { data } = await api.post('/monitoring/toggle-message-merge', { enabled });
      return unwrapResponse<{ enabled: boolean; message: string }>(data);
    },
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
    mutationFn: async (params: { id: string; type: 'chatId' | 'groupId' }) => {
      const { data } = await api.post('/config/blacklist', params);
      return unwrapResponse(data);
    },
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
    mutationFn: async (params: { id: string; type: 'chatId' | 'groupId' }) => {
      const { data } = await api.delete('/config/blacklist', { data: params });
      return unwrapResponse(data);
    },
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
    mutationFn: async (config: Partial<AgentReplyConfig>) => {
      const { data } = await api.post('/config/agent-config', config);
      return unwrapResponse<{ config: AgentReplyConfig; message: string }>(data);
    },
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
    mutationFn: async () => {
      const { data } = await api.post('/config/agent-config/reset');
      return unwrapResponse<{ config: AgentReplyConfig; message: string }>(data);
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['agent-reply-config'] });
      toast.success(data.message || '配置已重置');
    },
    onError: () => {
      toast.error('重置配置失败');
    },
  });
}
