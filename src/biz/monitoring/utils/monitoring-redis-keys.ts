/**
 * Monitoring 模块 Redis Key 常量
 *
 * 命名规范: monitoring:{type}[:{qualifier}]
 *
 * 数据结构速览:
 * - monitoring:counters            (Hash)        全局计数器，永久存储
 * - monitoring:current_processing  (String)      当前并发处理数，永久存储
 * - monitoring:peak_processing     (String)      峰值并发数，永久存储
 * - monitoring:today_users         (String/JSON) 今日用户缓存，30s TTL
 * - monitoring:active_users:{date} (Sorted Set)  活跃用户集合，24h TTL
 * - monitoring:active_chats:{date} (Sorted Set)  活跃会话集合，24h TTL
 */
export const MONITORING_REDIS_KEYS = {
  /** Hash - 全局累计计数器（totalMessages / totalSuccess / totalFailure 等） */
  COUNTERS: 'monitoring:counters',

  /** String - 当前正在处理的消息数 */
  CURRENT_PROCESSING: 'monitoring:current_processing',

  /** String - 历史峰值并发数 */
  PEAK_PROCESSING: 'monitoring:peak_processing',

  /** String(JSON) - 今日用户列表缓存，TTL 30s */
  TODAY_USERS: 'monitoring:today_users',

  /**
   * Sorted Set - 指定日期的活跃用户集合，TTL 24h
   * @param date YYYY-MM-DD 格式日期，缺省为今天
   */
  activeUsers: (date: string): string => `monitoring:active_users:${date}`,

  /**
   * Sorted Set - 指定日期的活跃会话集合，TTL 24h
   * @param date YYYY-MM-DD 格式日期，缺省为今天
   */
  activeChats: (date: string): string => `monitoring:active_chats:${date}`,

  /** 匹配所有活跃用户 key（用于 SCAN / keys 批量操作） */
  ACTIVE_USERS_PATTERN: 'monitoring:active_users:*',

  /** 匹配所有活跃会话 key（用于 SCAN / keys 批量操作） */
  ACTIVE_CHATS_PATTERN: 'monitoring:active_chats:*',
} as const;
