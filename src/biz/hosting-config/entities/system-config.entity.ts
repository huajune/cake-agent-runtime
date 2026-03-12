/**
 * 系统配置数据库记录
 * @table system_config
 */
export interface SystemConfigRecord {
  key: string;
  value: unknown;
  description?: string;
  created_at?: string;
  updated_at?: string;
}
