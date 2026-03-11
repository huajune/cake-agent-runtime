/**
 * 用户管理相关 Hooks
 *
 * 包含用户列表、用户趋势、托管控制等查询功能
 * 从 useMonitoring.ts 拆分而来（2025-12-16）
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { UserInfo, DashboardData } from '@/types/monitoring';
import { api, unwrapResponse } from './shared';

// ==================== 类型定义 ====================

// 用户趋势数据
export interface UserTrendData {
  date: string;
  uniqueUsers: number;
  messageCount: number;
  tokenUsage: number;
}

// 今日用户数据
export interface TodayUserData {
  chatId: string;
  odId: string;
  odName: string;
  groupName?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number;
  lastActiveAt: number;
  isPaused: boolean;
}

// 暂停的用户数据
export interface PausedUserData {
  chatId: string;
  pausedAt: number;
  odName?: string;
  groupName?: string;
}

// ==================== Query Hooks ====================

/**
 * 获取近1月托管用户趋势数据
 */
export function useUserTrend(autoRefresh = true) {
  return useQuery({
    queryKey: ['user-trend'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/user-trend');
      return unwrapResponse<UserTrendData[]>(data);
    },
    refetchInterval: autoRefresh ? 60000 : false, // 1分钟刷新一次
  });
}

/**
 * 获取今日托管用户列表（轻量级接口，仅返回用户数据）
 */
export function useTodayUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['today-users'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/users');
      return unwrapResponse<TodayUserData[]>(data);
    },
    refetchInterval: autoRefresh ? 10000 : false, // 10秒刷新一次
  });
}

/**
 * 获取已禁止托管的用户列表（附带用户资料）
 */
export function usePausedUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['paused-users'],
    queryFn: async () => {
      const { data } = await api.get('/user/users/paused');
      const response = unwrapResponse<{
        users: Array<{ userId: string; pausedAt: number; odName?: string; groupName?: string }>;
      }>(data);
      // 转换格式：userId -> chatId，保留用户资料
      return response.users.map((user) => ({
        chatId: user.userId,
        pausedAt: user.pausedAt,
        odName: user.odName,
        groupName: user.groupName,
      }));
    },
    refetchInterval: autoRefresh ? 10000 : false, // 10秒刷新一次
  });
}

/**
 * 用户列表（通用）
 */
export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/users');
      return unwrapResponse<UserInfo[]>(data);
    },
    refetchInterval: 10000,
  });
}

// ==================== Mutation Hooks ====================

/**
 * 用户托管控制 - 使用乐观更新让 UI 立即响应
 */
export function useToggleUserHosting() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ chatId, enabled }: { chatId: string; enabled: boolean }) => {
      const { data } = await api.post(`/user/users/${encodeURIComponent(chatId)}/hosting`, {
        enabled,
      });
      return unwrapResponse(data);
    },
    onMutate: async ({ chatId, enabled }) => {
      // 取消正在进行的查询
      await queryClient.cancelQueries({ queryKey: ['users'] });
      await queryClient.cancelQueries({ queryKey: ['dashboard'] });

      // 保存之前的状态
      const previousUsers = queryClient.getQueryData<UserInfo[]>(['users']);
      const previousDashboards: Record<string, DashboardData | undefined> = {};

      // 乐观更新 ['users'] 缓存
      if (previousUsers) {
        queryClient.setQueryData<UserInfo[]>(['users'],
          previousUsers.map(user =>
            user.chatId === chatId ? { ...user, hostingEnabled: enabled } : user
          )
        );
      }

      // 乐观更新 ['dashboard', timeRange] 缓存（页面实际读取的数据源）
      // 需要更新所有可能的 timeRange 缓存
      const timeRanges = ['today', 'week', 'month'];
      for (const range of timeRanges) {
        const dashboardData = queryClient.getQueryData<DashboardData>(['dashboard', range]);
        if (dashboardData?.todayUsers) {
          previousDashboards[range] = dashboardData;
          queryClient.setQueryData<DashboardData>(['dashboard', range], {
            ...dashboardData,
            todayUsers: dashboardData.todayUsers.map(user =>
              user.chatId === chatId ? { ...user, isPaused: !enabled } : user
            ),
          });
        }
      }

      return { previousUsers, previousDashboards };
    },
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? '已启用托管' : '已暂停托管');
    },
    onError: (_err, _vars, context) => {
      // 出错时回滚到之前的状态
      if (context?.previousUsers) {
        queryClient.setQueryData(['users'], context.previousUsers);
      }
      // 回滚 dashboard 缓存
      if (context?.previousDashboards) {
        for (const [range, data] of Object.entries(context.previousDashboards)) {
          if (data) {
            queryClient.setQueryData(['dashboard', range], data);
          }
        }
      }
      toast.error('操作失败，请重试');
    },
    onSettled: () => {
      // 无论成功失败，最终都重新获取最新状态
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

/**
 * 清空监控数据
 */
export function useClearData() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.post('/analytics/clear');
      return unwrapResponse(data);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['metrics'] });
      toast.success('监控数据已清空');
    },
    onError: () => {
      toast.error('清空数据失败');
    },
  });
}

/**
 * 清除缓存
 */
export function useClearCache() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (type: 'metrics' | 'history' | 'agent' | 'all') => {
      const { data } = await api.post(`/analytics/cache/clear?type=${type}`);
      return unwrapResponse(data);
    },
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
    onError: () => {
      toast.error('清除缓存失败');
    },
  });
}
