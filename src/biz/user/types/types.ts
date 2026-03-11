/**
 * 用户资料（从 user_activity 表查询）
 */
export interface UserProfile {
  chat_id: string;
  od_name?: string;
  group_name?: string;
}
