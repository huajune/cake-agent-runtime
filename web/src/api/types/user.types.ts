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

export interface UserInfo {
  chatId: string;
  userName?: string;
  messageCount: number;
  lastActiveAt?: string;
  hostingEnabled: boolean;
}
