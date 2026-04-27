/**
 * 用户管理相关 Hooks
 *
 * 包含用户列表、用户趋势、托管控制等查询功能
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import type { PausedUserData, TodayUserData, UserInfo } from '@/api/types/user.types';
import type { DashboardData } from '@/api/types/analytics.types';
import * as userService from '@/api/services/user.service';

export type { UserTrendData, TodayUserData, PausedUserData } from '@/api/services/user.service';

// ==================== Query Hooks ====================

/**
 * 获取近1月托管用户趋势数据
 */
export function useUserTrend(autoRefresh = true) {
  return useQuery({
    queryKey: ['user-trend'],
    queryFn: () => userService.getUserTrend(),
    refetchInterval: autoRefresh ? 60000 : false,
  });
}

/**
 * 获取今日托管用户列表
 */
export function useTodayUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['today-users'],
    queryFn: () => userService.getTodayUsers(),
    refetchInterval: autoRefresh ? 10000 : false,
  });
}

/**
 * 获取已禁止托管的用户列表
 */
export function usePausedUsers(autoRefresh = true) {
  return useQuery({
    queryKey: ['paused-users'],
    queryFn: () => userService.getPausedUsers(),
    refetchInterval: autoRefresh ? 10000 : false,
  });
}

/**
 * 用户列表（通用）
 */
export function useUsers() {
  return useQuery({
    queryKey: ['users'],
    queryFn: () => userService.getUsers(),
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
    mutationFn: ({ chatId, enabled }: { chatId: string; enabled: boolean }) =>
      userService.toggleUserHosting(chatId, enabled),
    onMutate: async ({ chatId, enabled }) => {
      await queryClient.cancelQueries({ queryKey: ['users'] });
      await queryClient.cancelQueries({ queryKey: ['today-users'] });
      await queryClient.cancelQueries({ queryKey: ['paused-users'] });
      await queryClient.cancelQueries({ queryKey: ['dashboard'] });
      await queryClient.cancelQueries({ queryKey: ['dashboard-overview'] });

      const previousUsers = queryClient.getQueryData<UserInfo[]>(['users']);
      const previousTodayUsers = queryClient.getQueryData<TodayUserData[]>(['today-users']);
      const previousPausedUsers = queryClient.getQueryData<PausedUserData[]>(['paused-users']);
      const previousDashboards: Record<string, DashboardData | undefined> = {};

      if (previousUsers) {
        queryClient.setQueryData<UserInfo[]>(
          ['users'],
          previousUsers.map((user) =>
            user.chatId === chatId ? { ...user, hostingEnabled: enabled } : user,
          ),
        );
      }

      if (previousTodayUsers) {
        queryClient.setQueryData<TodayUserData[]>(
          ['today-users'],
          previousTodayUsers.map((user) =>
            user.chatId === chatId ? { ...user, isPaused: !enabled } : user,
          ),
        );
      }

      if (previousPausedUsers && enabled) {
        queryClient.setQueryData<PausedUserData[]>(
          ['paused-users'],
          previousPausedUsers.filter((user) => user.chatId !== chatId),
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

      return { previousUsers, previousTodayUsers, previousPausedUsers, previousDashboards };
    },
    onSuccess: (_data, { enabled }) => {
      toast.success(enabled ? '已启用托管' : '已暂停托管');
    },
    onError: (_err, _vars, context) => {
      if (context?.previousUsers) {
        queryClient.setQueryData(['users'], context.previousUsers);
      }
      if (context?.previousTodayUsers) {
        queryClient.setQueryData(['today-users'], context.previousTodayUsers);
      }
      if (context?.previousPausedUsers) {
        queryClient.setQueryData(['paused-users'], context.previousPausedUsers);
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
      queryClient.invalidateQueries({ queryKey: ['today-users'] });
      queryClient.invalidateQueries({ queryKey: ['paused-users'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard-overview'] });
    },
  });
}
