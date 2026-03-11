/**
 * 错误日志数据库格式
 * @table monitoring_error_logs
 */
export interface ErrorLogDbRecord {
  message_id: string;
  timestamp: number;
  error: string;
  alert_type?: string;
}
