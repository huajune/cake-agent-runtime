/**
 * 用户活跃记录
 * @table user_activity
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
