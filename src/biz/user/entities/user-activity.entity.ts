/**
 * 用户活跃记录（历史形状，全库零引用，待删）。
 *
 * 注意：这里的字段与 user_activity 实际表结构已不一致（真实列是 token_usage 而非
 * total_tokens，且表按 (chat_id, activity_date) 每天一行、另有 bot_user_id/im_bot_id），
 * 各读写点均使用内联行类型，不要拿本接口当表结构参考。
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
