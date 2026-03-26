import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAgentReplyConfig } from './useSystemConfig';
import * as configService from '@/api/services/config.service';
import type { AgentReplyConfigResponse, GroupTaskConfig } from '@/api/types/config.types';

/**
 * 获取群任务配置（从 agent-config 响应里取，不额外请求）
 */
export function useGroupTaskConfig() {
  const { data, isLoading } = useAgentReplyConfig();
  return {
    data: data?.groupTaskConfig as GroupTaskConfig | undefined,
    isLoading,
  };
}

/**
 * 更新群任务配置
 *
 * 使用 setQueryData 乐观更新 groupTaskConfig 部分，
 * 避免 invalidateQueries 触发 refetch 冲掉消息配置表单的未保存编辑。
 */
export function useUpdateGroupTaskConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (config: Partial<GroupTaskConfig>) =>
      configService.updateGroupTaskConfig(config),
    onSuccess: (data) => {
      const serverConfig = (data as { config?: GroupTaskConfig })?.config;
      queryClient.setQueryData<AgentReplyConfigResponse>(
        ['agent-reply-config'],
        (old) => {
          if (!old) return old;
          return {
            ...old,
            groupTaskConfig: serverConfig ?? old.groupTaskConfig,
          };
        },
      );
      toast.success('配置已更新');
    },
    onError: () => {
      toast.error('配置更新失败');
    },
  });
}

/**
 * 手动触发群任务
 */
export function useTriggerGroupTask() {
  return useMutation({
    mutationFn: (type: string) =>
      import('@/api/services/group-task.service').then((m) => m.triggerGroupTask(type)),
    onSuccess: () => {
      toast.success('任务已触发');
    },
    onError: () => {
      toast.error('任务触发失败');
    },
  });
}
