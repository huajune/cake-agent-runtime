/**
 * 用户数据转换工具函数
 * 负责将不同来源的用户数据统一为 UserTable 所需格式
 */

import type { UserData } from '../types';

/**
 * 暂停用户数据格式
 */
export interface PausedUserRaw {
  chatId: string;
  pausedAt: number;
  pauseExpiresAt: number;
  odName?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
}

/**
 * 转换暂停用户数据为表格格式
 * @param pausedUsers - 原始暂停用户数据
 * @returns 表格用户数据
 */
export function transformPausedUsers(pausedUsers: PausedUserRaw[]): UserData[] {
  return pausedUsers.map((user) => ({
    chatId: user.chatId,
    odName: user.odName,
    groupName: user.groupName,
    botUserId: user.botUserId,
    imBotId: user.imBotId,
    messageCount: 0,
    tokenUsage: 0,
    firstActiveAt: user.pausedAt, // 直接使用时间戳
    lastActiveAt: user.pausedAt, // 直接使用时间戳
    isPaused: true,
    pauseExpiresAt: user.pauseExpiresAt,
  }));
}
