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
  /** 自动解禁时间戳（毫秒）；永久暂停为 null */
  pauseExpiresAt: number | null;
  /** 是否永久暂停（不自动解禁） */
  isPermanent: boolean;
  /** 暂停理由（如候选人黑名单的拉黑理由） */
  pauseReason?: string;
  /** 操作人 */
  pauseOperator?: string;
  /** 暂停来源：manual / candidate_blacklist / interview_booking / intervention / human_intervention */
  pauseSource?: string;
  odName?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
}

export interface PauseUserHostingParams {
  userId: string;
  permanent?: boolean;
  reason?: string;
  operator?: string;
}

export interface PauseUserHostingResponse {
  userId: string;
  isPaused: boolean;
  isPermanent: boolean;
  message: string;
}

export interface UserInfo {
  chatId: string;
  userName?: string;
  messageCount: number;
  lastActiveAt?: string;
  hostingEnabled: boolean;
}
