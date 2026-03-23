/**
 * 策略配置变更日志实体
 */
export interface StrategyChangelogRecord {
  id: string;
  config_id: string;
  field: 'persona' | 'stage_goals' | 'red_lines';
  old_value: unknown;
  new_value: unknown;
  changed_at: string;
  changed_by?: string;
}
