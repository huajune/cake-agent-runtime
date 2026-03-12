/**
 * 错误日志数据库记录
 * @table monitoring_error_logs
 * timestamp 字段在迁移 20260312000001 中由 bigint 变更为 timestamptz，
 * 因此此处类型为 string（Supabase 返回 ISO 8601 字符串）。
 */
export interface ErrorLogDbRecord {
  message_id: string;
  timestamp: string; // timestamptz → ISO 8601 string
  error: string;
  alert_type?: string;
}
