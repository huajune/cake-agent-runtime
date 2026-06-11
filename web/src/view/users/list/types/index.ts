/**
 * Users 模块类型定义
 */

/**
 * 用户数据接口（表格展示）
 */
export interface UserData {
  chatId: string;
  odName?: string;
  groupName?: string;
  botUserId?: string;
  imBotId?: string;
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number; // 时间戳（毫秒）
  lastActiveAt: number; // 时间戳（毫秒）
  isPaused: boolean;
  pauseExpiresAt?: number | null; // 暂停自动解禁时间戳（毫秒），永久暂停为 null，仅暂停用户列表使用
  isPermanent?: boolean; // 是否永久暂停（不自动解禁）
  pauseReason?: string; // 暂停理由（如候选人黑名单的拉黑理由）
  pauseOperator?: string; // 操作人
  pauseSource?: string; // 暂停来源：manual / candidate_blacklist / interview_booking / intervention
}

/**
 * Tab 类型
 */
export type TabType = 'today' | 'paused';

/**
 * 用户表格属性
 */
export interface UserTableProps {
  users: UserData[];
  isLoading: boolean;
  onToggleHosting: (chatId: string, enabled: boolean) => void;
  isPausedTab?: boolean;
  pendingChatId?: string;
  emptyMessage?: string;
  resolveBotLabel?: (user: Pick<UserData, 'botUserId' | 'imBotId'>) => string;
}
