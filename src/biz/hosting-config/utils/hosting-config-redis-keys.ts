/**
 * Hosting-Config 模块 Redis Key 常量
 *
 * 命名规范: config:{key_name}
 *
 * 数据结构速览:
 * - config:ai_reply_enabled      (String/JSON) AI回复开关缓存，TTL 5min
 * - config:message_merge_enabled (String/JSON) 消息聚合开关缓存，TTL 5min
 * - config:agent_reply_config    (String/JSON) Agent回复策略配置缓存，TTL 1min
 * - config:system_config         (String/JSON) 系统配置缓存，TTL 5min
 * - config:group_blacklist       (String/JSON) 小组黑名单缓存，TTL 5min
 */
export const HOSTING_CONFIG_REDIS_KEYS = {
  /** String(JSON bool) - AI 自动回复功能开关，TTL 5min */
  AI_REPLY_ENABLED: 'config:ai_reply_enabled',

  /** String(JSON bool) - 消息聚合功能开关，TTL 5min */
  MESSAGE_MERGE_ENABLED: 'config:message_merge_enabled',

  /** String(JSON) - Agent 回复策略配置（延迟、打字速度等），TTL 1min */
  AGENT_REPLY_CONFIG: 'config:agent_reply_config',

  /** String(JSON) - 系统配置（Worker 并发数等），TTL 5min */
  SYSTEM_CONFIG: 'config:system_config',

  /** String(JSON array) - 小组黑名单列表，TTL 5min */
  GROUP_BLACKLIST: 'config:group_blacklist',
} as const;
