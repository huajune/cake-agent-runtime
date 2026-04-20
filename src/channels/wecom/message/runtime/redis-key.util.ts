/**
 * Redis Key 构建器
 *
 * 命名规范: {app}:{module}:{type}:{id}
 * 示例: wecom:message:dedup:msg_123456
 *
 * 环境隔离不在此处处理：所有 Redis 调用都会经过 RedisService.withPrefix
 * 注入 `{RUNTIME_ENV|NODE_ENV}:` 前缀，避免双重前缀。
 */
export class RedisKeyBuilder {
  private static readonly APP_PREFIX = 'wecom';
  private static readonly MODULE = 'message';

  private static get scope(): string {
    return `${this.APP_PREFIX}:${this.MODULE}`;
  }

  /** 消息去重 Key（TTL 由 DeduplicationService 控制，默认 2 小时） */
  static dedup(messageId: string): string {
    return `${this.scope}:dedup:${messageId}`;
  }

  /** 消息聚合队列 Key（TTL 由 SimpleMergeService 控制，默认 5 分钟） */
  static pending(chatId: string): string {
    return `${this.scope}:pending:${chatId}`;
  }

  /** 会话最后一条消息到达时间 Key */
  static lastMessageAt(chatId: string): string {
    return `${this.scope}:last-message-at:${chatId}`;
  }

  /** 消息历史缓存 Key（预留） */
  static history(chatId: string): string {
    return `${this.scope}:history:${chatId}`;
  }

  /** 处理状态锁 Key */
  static lock(chatId: string): string {
    return `${this.scope}:lock:${chatId}`;
  }

  /** 企微消息 trace 上下文 Key */
  static trace(messageId: string): string {
    return `${this.scope}:trace:${messageId}`;
  }

  /** 批量匹配模式（用于 SCAN 操作） */
  static pattern(
    type: 'dedup' | 'pending' | 'history' | 'lock' | 'last-message-at' | 'trace',
  ): string {
    return `${this.scope}:${type}:*`;
  }

  /** 获取模块前缀；与 RedisService 的 env 前缀拼接后用于清理本模块 Redis 数据 */
  static get modulePrefix(): string {
    return `${this.scope}:`;
  }
}
