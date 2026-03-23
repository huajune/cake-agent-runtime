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
  messageCount: number;
  tokenUsage: number;
  firstActiveAt: number; // 时间戳（毫秒）
  lastActiveAt: number; // 时间戳（毫秒）
  isPaused: boolean;
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
}
