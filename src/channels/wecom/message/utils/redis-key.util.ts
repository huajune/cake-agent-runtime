/**
 * Redis Key 构建器
 * 统一管理所有 Redis Key 的前缀和格式
 *
 * 命名规范: {app}:{module}:{type}:{id}
 * 示例: wecom:message:dedup:msg_123456
 */
export class RedisKeyBuilder {
  // 应用前缀，避免多应用共用 Redis 时冲突
  private static readonly APP_PREFIX = 'wecom';

  // 模块前缀
  private static readonly MODULE = 'message';

  /**
   * 消息去重 Key
   * 用于防止同一消息被重复处理
   *
   * 格式: wecom:message:dedup:{messageId}
   * TTL: 由 DeduplicationService 控制（默认 2 小时）
   */
  static dedup(messageId: string): string {
    return `${this.APP_PREFIX}:${this.MODULE}:dedup:${messageId}`;
  }

  /**
   * 消息聚合队列 Key
   * 用于存储待聚合的消息列表
   *
   * 格式: wecom:message:pending:{chatId}
   * TTL: 由 SimpleMergeService 控制（默认 5 分钟）
   */
  static pending(chatId: string): string {
    return `${this.APP_PREFIX}:${this.MODULE}:pending:${chatId}`;
  }

  /**
   * 消息历史缓存 Key（预留）
   * 用于缓存会话历史记录
   *
   * 格式: wecom:message:history:{chatId}
   */
  static history(chatId: string): string {
    return `${this.APP_PREFIX}:${this.MODULE}:history:${chatId}`;
  }

  /**
   * 处理状态锁 Key（预留）
   * 用于分布式锁，防止同一会话并发处理
   *
   * 格式: wecom:message:lock:{chatId}
   */
  static lock(chatId: string): string {
    return `${this.APP_PREFIX}:${this.MODULE}:lock:${chatId}`;
  }

  /**
   * 批量匹配模式（用于 SCAN 操作）
   *
   * @param type Key 类型
   * @returns 匹配模式字符串
   */
  static pattern(type: 'dedup' | 'pending' | 'history' | 'lock'): string {
    return `${this.APP_PREFIX}:${this.MODULE}:${type}:*`;
  }

  /**
   * 获取完整前缀
   * 用于清理所有消息模块的 Redis 数据
   */
  static get modulePrefix(): string {
    return `${this.APP_PREFIX}:${this.MODULE}:`;
  }
}
