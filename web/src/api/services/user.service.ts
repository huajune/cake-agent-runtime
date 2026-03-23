import type { UserInfo } from '../types/user.types';
import type { UserTrendData, TodayUserData } from '../types/user.types';
import { api, unwrapResponse } from '../client';

export type { UserTrendData, TodayUserData, PausedUserData } from '../types/user.types';

export async function getUserTrend() {
  const { data } = await api.get('/analytics/user-trend');
  return unwrapResponse<UserTrendData[]>(data);
}

export async function getTodayUsers() {
  const { data } = await api.get('/analytics/users');
  return unwrapResponse<TodayUserData[]>(data);
}

export async function getPausedUsers() {
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
}

export async function getUsers() {
  const { data } = await api.get('/analytics/users');
  return unwrapResponse<UserInfo[]>(data);
}

export async function toggleUserHosting(chatId: string, enabled: boolean) {
  const { data } = await api.post(`/user/users/${encodeURIComponent(chatId)}/hosting`, {
    enabled,
  });
  return unwrapResponse(data);
}
