/**
 * 小时统计数据库记录格式
 * @table monitoring_hourly_stats
 */
export interface HourlyStatsDbRecord {
  hour: string;
  message_count: number;
  success_count: number;
  failure_count: number;
  success_rate: number;
  avg_duration: number;
  min_duration: number;
  max_duration: number;
  p50_duration: number;
  p95_duration: number;
  p99_duration: number;
  avg_ai_duration: number;
  avg_send_duration: number;
  active_users: number;
  active_chats: number;
  total_token_usage: number;
  fallback_count: number;
  fallback_success_count: number;
  scenario_stats: Record<string, { count: number; successCount: number; avgDuration: number }>;
  tool_stats: Record<string, number>;
}
