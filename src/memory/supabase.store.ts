import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisService } from '@infra/redis/redis.service';
import type { AgentMemoryRow, MemoryEntry, MemoryStore } from './memory.types';
import { MEMORY_TTL } from './memory.types';
import { deepMerge } from './deep-merge.util';

const TABLE = 'agent_memories';

/**
 * Supabase 存储后端（profile 类别专用）
 *
 * 永久持久化到 Supabase + Redis 2h 缓存。
 * 读取时 Redis 优先，miss 回落 Supabase 并回填缓存。
 * Supabase 不可用时 graceful 降级（warn log，不抛异常）。
 *
 * 本期仅搭基础设施，暂无上层调用方。
 */
@Injectable()
export class SupabaseStore implements MemoryStore {
  private readonly logger = new Logger(SupabaseStore.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
  ) {}

  // ---- 公共接口 ----

  async get(key: string): Promise<MemoryEntry | null> {
    // Redis 缓存优先
    const cached = await this.redis.get<MemoryEntry>(key);
    if (cached) return cached;

    // 回落 Supabase
    const row = await this.findRow(key);
    if (!row) return null;

    const entry: MemoryEntry = {
      key: row.memory_key,
      content: row.content,
      updatedAt: row.updated_at,
    };

    // 回填缓存
    await this.redis.setex(key, MEMORY_TTL.PROFILE_CACHE, entry).catch((err) => {
      this.logger.warn('Redis 缓存回填失败', err);
    });

    return entry;
  }

  async set(key: string, content: Record<string, unknown>): Promise<void> {
    const { corpId, userId, memoryKey } = this.parseProfileKey(key);

    // deepMerge 已有值
    const existing = await this.get(key);
    const merged = existing
      ? (deepMerge(existing.content, content) as Record<string, unknown>)
      : content;

    const entry: MemoryEntry = {
      key,
      content: merged,
      updatedAt: new Date().toISOString(),
    };

    // 写入 Supabase
    await this.upsertRow(corpId, userId, memoryKey, merged);

    // 回填 Redis 缓存
    await this.redis.setex(key, MEMORY_TTL.PROFILE_CACHE, entry).catch((err) => {
      this.logger.warn('Redis 缓存写入失败', err);
    });
  }

  async del(key: string): Promise<boolean> {
    const { corpId, userId, memoryKey } = this.parseProfileKey(key);

    // 双删：Redis + Supabase
    await this.redis.del(key).catch(() => {});

    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，仅删除 Redis 缓存');
      return true;
    }

    const { error } = await client
      .from(TABLE)
      .delete()
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .eq('memory_key', memoryKey);

    if (error) {
      this.logger.warn('Supabase 删除失败', error.message);
      return false;
    }

    return true;
  }

  /**
   * 查询用户的所有 profile 记忆
   */
  async findAll(corpId: string, userId: string): Promise<MemoryEntry[]> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，返回空列表');
      return [];
    }

    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (error) {
      this.logger.warn('Supabase 查询失败', error.message);
      return [];
    }

    return (data as AgentMemoryRow[]).map((row) => ({
      key: row.memory_key,
      content: row.content,
      updatedAt: row.updated_at,
    }));
  }

  // ---- 内部方法 ----

  private async findRow(key: string): Promise<AgentMemoryRow | null> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用');
      return null;
    }

    const { corpId, userId, memoryKey } = this.parseProfileKey(key);

    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .eq('memory_key', memoryKey)
      .maybeSingle();

    if (error) {
      this.logger.warn('Supabase 查询失败', error.message);
      return null;
    }

    return data as AgentMemoryRow | null;
  }

  private async upsertRow(
    corpId: string,
    userId: string,
    memoryKey: string,
    content: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，profile 记忆仅存入 Redis 缓存');
      return;
    }

    const { error } = await client.from(TABLE).upsert(
      {
        corp_id: corpId,
        user_id: userId,
        memory_key: memoryKey,
        category: 'profile',
        content,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'corp_id,user_id,memory_key' },
    );

    if (error) {
      this.logger.warn('Supabase upsert 失败', error.message);
    }
  }

  /**
   * 解析 profile key: "profile:{corpId}:{userId}:{memoryKey}"
   */
  private parseProfileKey(key: string): {
    corpId: string;
    userId: string;
    memoryKey: string;
  } {
    const parts = key.replace(/^profile:/, '').split(':');
    return {
      corpId: parts[0] ?? '',
      userId: parts[1] ?? '',
      memoryKey: parts.slice(2).join(':') || 'default',
    };
  }
}
