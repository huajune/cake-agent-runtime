/**
 * 日级统计数据库记录
 * @table monitoring_daily_stats
 */
export interface DailyStatsDbRecord {
  stat_date: string;
  message_count: number;
  success_count: number;
  failure_count: number;
  timeout_count: number;
  success_rate: number;
  avg_duration: number;
  total_token_usage: number;
  unique_users: number;
  unique_chats: number;
  fallback_count: number;
  fallback_success_count: number;
  fallback_affected_users: number;
  avg_queue_duration: number;
  avg_prep_duration: number;
  error_type_stats: Record<string, number>;
}
