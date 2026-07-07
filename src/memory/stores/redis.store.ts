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

  // ==================== Hash（字段级原子写） ====================
  //
  // 单 JSON blob 的 set(merge) 是读-改-写，并发写入方（入站 fire-and-forget、
  // 复聊 processor、worker 回合收尾）会互相覆盖对方刚写的字段（P0 丢更新）。
  // Hash 形态下每个 top-level 字段一个 hash field，HSET 只碰自己的字段，
  // 跨字段并发写天然隔离；同字段写入方由上层（chat 处理锁）负责串行。

  /** 读取 hash 全部字段。key 不存在返回 null。 */
  async getHash(key: string): Promise<Record<string, unknown> | null> {
    const fields = await this.redis.hgetall(key);
    return fields && Object.keys(fields).length > 0 ? fields : null;
  }

  /** 原子写入 patch 中的字段（其余字段不受影响），并续期 TTL。 */
  async patchHash(key: string, patch: Record<string, unknown>, ttl?: number): Promise<void> {
    const args = this.toHashEvalArgs(patch, ttl);
    if (args.length <= 1) return;

    await this.redis.eval(
      `
        local changed = 0
        for i = 2, #ARGV, 2 do
          changed = changed + redis.call("hset", KEYS[1], ARGV[i], ARGV[i + 1])
        end
        if tonumber(ARGV[1]) > 0 then
          redis.call("expire", KEYS[1], ARGV[1])
        end
        return changed
      `,
      [key],
      args,
    );
    this.logger.debug(`记忆已按字段更新: ${key} [${Object.keys(patch).join(',')}]`);
  }

  /**
   * 仅补齐缺失字段（HSETNX 逐字段），不覆盖已有值。
   * 用于旧版单 blob → hash 的惰性迁移：并发迁移/并发新写入都不会被回填覆盖。
   */
  async backfillHash(key: string, fields: Record<string, unknown>, ttl?: number): Promise<void> {
    const args = this.toHashEvalArgs(fields, ttl);
    if (args.length <= 1) return;

    await this.redis.eval(
      `
        local changed = 0
        for i = 2, #ARGV, 2 do
          changed = changed + redis.call("hsetnx", KEYS[1], ARGV[i], ARGV[i + 1])
        end
        if tonumber(ARGV[1]) > 0 then
          redis.call("expire", KEYS[1], ARGV[1])
        end
        return changed
      `,
      [key],
      args,
    );
  }

  private toHashEvalArgs(fields: Record<string, unknown>, ttl?: number): (string | number)[] {
    const args: (string | number)[] = [ttl ?? 0];
    for (const [field, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      args.push(field, this.serializeRedisValue(value));
    }
    return args;
  }

  private serializeRedisValue(value: unknown): string | number {
    switch (typeof value) {
      case 'number':
      case 'string':
        return value;
      case 'boolean':
        return String(value);
      default:
        return JSON.stringify(value);
    }
  }
}
