import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@infra/redis/redis.service';
import type { MemoryEntry, MemoryStore } from './store.types';
import { deepMerge } from './deep-merge.util';

/**
 * Redis 存储后端
 *
 * 通用 Redis key-value 存储，支持可配置 TTL 和可选 deepMerge。
 * MemoryService 按类别（stage / facts / profile-cache）委派到此后端。
 *
 * 这里不关心具体业务字段名，例如：
 * - `lastSessionActiveAt`
 * - `currentStage / fromStage`
 * - `presentedJobs`
 *
 * RedisStore 只负责把 content 按 entry 结构存进去，并附带 updatedAt。
 */
@Injectable()
export class RedisStore implements MemoryStore {
  private readonly logger = new Logger(RedisStore.name);

  constructor(private readonly redis: RedisService) {}

  async get(key: string): Promise<MemoryEntry | null> {
    return this.redis.get<MemoryEntry>(key);
  }

  /**
   * 写入记忆
   * @param key Redis key
   * @param content 要存储的内容
   * @param ttl 过期时间（秒）
   * @param merge 是否与已有值 deepMerge（facts 类别需要）
   */
  async set(
    key: string,
    content: Record<string, unknown>,
    ttl?: number,
    merge?: boolean,
  ): Promise<void> {
    let finalContent = content;

    if (merge) {
      const existing = await this.get(key);
      if (existing) {
        finalContent = deepMerge(existing.content, content) as Record<string, unknown>;
      }
    }

    const entry: MemoryEntry = {
      key,
      content: finalContent,
      updatedAt: new Date().toISOString(),
    };

    if (ttl) {
      await this.redis.setex(key, ttl, entry);
    } else {
      await this.redis.set(key, entry);
    }

    this.logger.debug(`记忆已存储: ${key}`);
  }

  async del(key: string): Promise<boolean> {
    const count = await this.redis.del(key);
    if (count > 0) this.logger.debug(`记忆已删除: ${key}`);
    return count > 0;
  }
}
