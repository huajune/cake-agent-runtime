/**
 * 错误日志数据库记录
 * @table monitoring_error_logs
 * timestamp 字段在迁移 20260312000001 中由 bigint 变更为 timestamptz，
 * 因此此处类型为 string（Supabase 返回 ISO 8601 字符串）。
 */
export interface ErrorLogDbRecord {
  message_id?: string | null; // 系统级告警可能无 messageId（迁移 20260611 改为可空）
  timestamp: string; // timestamptz → ISO 8601 string
  error: string;
  alert_type?: string;
  // 子系统告警来源与投递状态（迁移 20260611 新增；老数据为 NULL）
  subsystem?: string | null;
  component?: string | null;
  action?: string | null;
  severity?: string | null;
  summary?: string | null;
  code?: string | null;
  dedupe_key?: string | null;
  throttled?: boolean | null;
  delivered?: boolean | null;
}
