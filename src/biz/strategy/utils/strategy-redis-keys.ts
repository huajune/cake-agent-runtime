/**
 * Strategy 模块 Redis Key 常量
 *
 * 命名规范: config:{domain}:{qualifier}
 *
 * 数据结构速览:
 * - config:strategy_config:active (String/JSON) 当前激活的策略配置，TTL 5min
 */
export const STRATEGY_REDIS_KEYS = {
  /** String(JSON) - 当前激活的策略配置（Persona / StageGoals / RedLines），TTL 5min */
  ACTIVE_CONFIG: 'config:strategy_config:active',
} as const;
