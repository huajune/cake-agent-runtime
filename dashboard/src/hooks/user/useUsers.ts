/**
 * 用户管理相关 Hooks
 *
 * 包含用户列表、用户趋势、托管控制等查询功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { UserInfo, DashboardData } from '@/types/monitoring';
import { api, unwrapResponse } from '../shared';

// ==================== 类型定义 ====================

export interface UserTrendData {
  date: string;
  uniqueUsers: number;
  messageCount: number;
  tokenUsage: number;
}

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
    refetchInterval: autoRefresh ? 60000 : false,
  });
}

/**
 * 获取今日托管用户列表
 */
export function useTodayUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['today-users'],
    queryFn: async () => {
      const { data } = await api.get('/analytics/users');
      return unwrapResponse<TodayUserData[]>(data);
    },
    refetchInterval: autoRefresh ? 10000 : false,
  });
}

/**
 * 获取已禁止托管的用户列表
 */
export function usePausedUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['paused-users'],
    queryFn: async () => {
      const { data } = await api.get('/user/users/paused');
      const response = unwrapResponse<{
        users: Array<{ userId: string; pausedAt: number; odName?: string; groupName?: string }>;
      }>(data);
      return response.users.map((user) => ({
        chatId: user.userId,
        pausedAt: user.pausedAt,
        odName: user.odName,
        groupName: user.groupName,
      }));
    },
    refetchInterval: autoRefresh ? 10000 : false,
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
      await queryClient.cancelQueries({ queryKey: ['users'] });
      await queryClient.cancelQueries({ queryKey: ['dashboard'] });

      const previousUsers = queryClient.getQueryData<UserInfo[]>(['users']);
      const previousDashboards: Record<string, DashboardData | undefined> = {};

      if (previousUsers) {
        queryClient.setQueryData<UserInfo[]>(
          ['users'],
          previousUsers.map((user) =>
            user.chatId === chatId ? { ...user, hostingEnabled: enabled } : user,
          ),
        );
      }

      const timeRanges = ['today', 'week', 'month'];
      for (const range of timeRanges) {
        const dashboardData = queryClient.getQueryData<DashboardData>(['dashboard', range]);
        if (dashboardData?.todayUsers) {
          previousDashboards[range] = dashboardData;
          queryClient.setQueryData<DashboardData>(['dashboard', range], {
            ...dashboardData,
            todayUsers: dashboardData.todayUsers.map((user) =>
              user.chatId === chatId ? { ...user, isPaused: !enabled } : user,
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
      if (context?.previousUsers) {
        queryClient.setQueryData(['users'], context.previousUsers);
      }
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
      queryClient.invalidateQueries({ queryKey: ['users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}
