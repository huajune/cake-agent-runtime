import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '@infra/redis/redis.service';
import { RedisKeyBuilder } from '../utils/redis-key.util';

/**
 * 消息去重服务（Redis 版本）
 *
 * 重构说明：
 * - 从内存 Map 迁移到 Redis，支持分布式部署
 * - 多进程/多实例场景下去重安全
 * - TTL 由 Redis 自动管理，无需手动清理
 *
 * 使用场景：
 * - 防止企微回调重试导致的重复处理
 * - 与消息聚合（SimpleMergeService）配合，确保消息不重复
 */
@Injectable()
export class MessageDeduplicationService implements OnModuleInit {
  private readonly logger = new Logger(MessageDeduplicationService.name);

  // 配置
  private readonly dedupeTTLSeconds: number; // TTL 秒数

  constructor(
    private readonly configService: ConfigService,
    private readonly redisService: RedisService,
  ) {
    // TTL 配置：默认 5 分钟
    this.dedupeTTLSeconds = parseInt(
      this.configService.get('MESSAGE_DEDUP_TTL_SECONDS', '300'),
      10,
    );
  }

  async onModuleInit() {
    this.logger.log(`消息去重服务已初始化 (Redis): TTL=${this.dedupeTTLSeconds}秒`);
  }

  /**
   * 检查消息是否已处理（异步）
   */
  async isMessageProcessedAsync(messageId: string): Promise<boolean> {
    const key = RedisKeyBuilder.dedup(messageId);
    const exists = await this.redisService.exists(key);
    return exists > 0;
  }

  /**
   * 标记消息为已处理（异步）
   * 使用原子 SET NX EX 确保只有第一个处理者能成功标记，无竞态条件
   *
   * @returns true 如果成功标记（第一个处理者），false 如果已被其他进程标记
   */
  async markMessageAsProcessedAsync(messageId: string): Promise<boolean> {
    const key = RedisKeyBuilder.dedup(messageId);

    // 原子操作：SET key value NX EX ttl
    // 返回 "OK" 表示成功设置（第一个处理者）
    // 返回 null 表示 key 已存在（已被其他进程处理）
    const client = this.redisService.getClient();
    const result = await client.set(key, Date.now().toString(), {
      nx: true,
      ex: this.dedupeTTLSeconds,
    });

    if (result === null) {
      this.logger.debug(`[去重] 消息 [${messageId}] 已被其他进程处理`);
      return false;
    }

    return true;
  }

  /**
   * 清理所有缓存（用于测试或手动清理）
   * 注意：这会删除所有去重相关的 key
   */
  async clearAll(): Promise<void> {
    // 使用 SCAN 查找所有去重 key
    let cursor: string | number = 0;
    let deletedCount = 0;

    do {
      const [nextCursor, keys] = await this.redisService.scan(cursor, {
        match: RedisKeyBuilder.pattern('dedup'),
        count: 100,
      });
      cursor = nextCursor;

      if (keys.length > 0) {
        await this.redisService.del(...keys);
        deletedCount += keys.length;
      }
    } while (cursor !== 0 && cursor !== '0');

    this.logger.log(`已清理所有消息去重缓存: ${deletedCount} 条`);
  }

  /**
   * 获取统计信息
   * 注意：Redis 版本无法精确获取缓存大小，返回估算值
   */
  getStats() {
    return {
      storage: 'redis',
      keyPattern: RedisKeyBuilder.pattern('dedup'),
      ttlSeconds: this.dedupeTTLSeconds,
      note: '使用 Redis 存储，TTL 自动管理',
    };
  }

  /**
   * 清理过期的消息记录（Redis 版本无需手动清理）
   * 保留此方法用于兼容 MessageStatisticsService
   */
  cleanupExpiredMessages(): number {
    // Redis TTL 自动清理，无需手动操作
    return 0;
  }
}
