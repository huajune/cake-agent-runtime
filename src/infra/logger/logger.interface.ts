/**
 * 日志条目接口
 */
export interface LogEntry {
  timestamp: string;
  level: 'log' | 'error' | 'warn' | 'debug' | 'verbose';
  context: string;
  message: string;
  trace?: string;
}
