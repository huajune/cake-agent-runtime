/**
 * 用户托管状态记录
 */
export interface UserHostingStatus {
  user_id: string;
  is_paused: boolean;
  paused_at: string | null;
  resumed_at: string | null;
  pause_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * 用户活跃记录
 */
export interface UserActivityRecord {
  chat_id: string;
  od_id?: string;
  od_name?: string;
  group_id?: string;
  group_name?: string;
  last_active_at: string;
  message_count: number;
  total_tokens: number;
  created_at?: string;
  updated_at?: string;
}

/**
 * 用户资料（从 user_activity 表查询）
 */
export interface UserProfile {
  chat_id: string;
  od_name?: string;
  group_name?: string;
}
