export interface UserTrendData {
  date: string;
  userCount: number;
  messageCount: number;
}

export interface TodayUserData {
  chatId: string;
  odId: string;
  odName: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number;
  lastActiveAt: number;
  isPaused: boolean;
}

export interface PausedUserData {
  chatId: string;
  pausedAt: number;
  pauseExpiresAt: number;
  odName?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
}

export interface UserInfo {
  chatId: string;
  userName?: string;
  messageCount: number;
  lastActiveAt?: string;
  hostingEnabled: boolean;
}
