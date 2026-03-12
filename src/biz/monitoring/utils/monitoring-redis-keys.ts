/**
 * Monitoring 模块 Redis Key 常量
 *
 * 命名规范: monitoring:{type}
 *
 * 数据结构速览:
 * - monitoring:counters          (Hash)   全局累计计数器，永久存储
 * - monitoring:current_processing (String) 当前并发处理数，无 TTL
 * - monitoring:peak_processing    (String) 历史峰值处理数，无 TTL
 * - monitoring:today_users        (String/JSON) 今日用户缓存，TTL 30s
 */
export const MONITORING_REDIS_KEYS = {
  /** Hash - 全局累计计数器（totalMessages, success, failure 等），永久存储 */
  COUNTERS: 'monitoring:counters',

  /** String - 当前并发处理消息数，实时更新，无 TTL */
  CURRENT_PROCESSING: 'monitoring:current_processing',

  /** String - 历史峰值并发处理数，无 TTL */
  PEAK_PROCESSING: 'monitoring:peak_processing',

  /** String(JSON) - 今日用户列表缓存，TTL 30s */
  TODAY_USERS: 'monitoring:today_users',
} as const;
