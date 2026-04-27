/**
 * 用户资料（从 user_activity 表查询）
 */
export interface UserProfile {
  chatId: string;
  odName?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
}

/**
 * user_activity 聚合查询结果（按日期范围）
 */
export interface UserActivityAggregate {
  chatId: string;
  odId?: string;
  odName?: string;
  groupId?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number;
  lastActiveAt: number;
}
