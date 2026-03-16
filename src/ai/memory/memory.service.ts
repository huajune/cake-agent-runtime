import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '@core/redis';
import { MemoryEntry } from './memory.types';
import { deepMerge } from './deep-merge.util';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60; // 24h

/**
 * 通用记忆服务 — 基于 Redis 的 key-value 存储
 *
 * 对标 ZeroClaw src/memory/ 的 store / recall / forget / list。
 * 特色：store 自动 deepMerge 已有值（null 不覆盖、数组累积去重）。
 */
@Injectable()
export class MemoryService {
  private readonly logger = new Logger(MemoryService.name);

  constructor(private readonly redis: RedisService) {}

  /** 存储记忆（自动 deepMerge 已有值） */
  async store(key: string, content: Record<string, unknown>, ttl?: number): Promise<void> {
    const existing = await this.recall(key);
    const merged = existing
      ? (deepMerge(existing.content, content) as Record<string, unknown>)
      : content;

    const entry: MemoryEntry = {
      key,
      content: merged,
      updatedAt: new Date().toISOString(),
    };
    await this.redis.setex(key, ttl ?? DEFAULT_TTL_SECONDS, entry);
    this.logger.debug('记忆已存储: ' + key);
  }

  /** 回忆记忆 */
  async recall(key: string): Promise<MemoryEntry | null> {
    return this.redis.get<MemoryEntry>(key);
  }

  /** 遗忘记忆 */
  async forget(key: string): Promise<boolean> {
    const count = await this.redis.del(key);
    if (count > 0) this.logger.debug('记忆已遗忘: ' + key);
    return count > 0;
  }
}
