import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisService } from '@infra/redis/redis.service';
import { MemoryConfig } from '../memory.config';
import type {
  AgentMemoryRow,
  UserProfile,
  SummaryData,
  SummaryEntry,
  MessageMetadata,
  MemoryEntry,
  MemoryStore,
} from '../memory.types';
import { MAX_RECENT_SUMMARIES } from '../memory.types';

const TABLE = 'agent_memories';

/**
 * Supabase 存储后端 — 长期记忆（每用户一行）
 *
 * 表结构：Profile 平铺列 + summary_data jsonb + message_metadata jsonb
 * 唯一约束 (corp_id, user_id)，每用户一行。
 * Redis 2h 缓存整行数据。
 * Supabase 不可用时 graceful 降级。
 */
@Injectable()
export class SupabaseStore implements MemoryStore {
  private readonly logger = new Logger(SupabaseStore.name);

  constructor(
    private readonly supabase: SupabaseService,
    private readonly redis: RedisService,
    private readonly config: MemoryConfig,
  ) {}

  // ==================== Profile 操作 ====================

  async getProfile(corpId: string, userId: string): Promise<UserProfile | null> {
    const row = await this.getRow(corpId, userId);
    if (!row) return null;

    return {
      name: row.name ?? null,
      phone: row.phone ?? null,
      gender: row.gender ?? null,
      age: row.age ?? null,
      is_student: row.is_student ?? null,
      education: row.education ?? null,
      has_health_certificate: row.has_health_certificate ?? null,
    };
  }

  async upsertProfile(
    corpId: string,
    userId: string,
    profile: Partial<UserProfile>,
    metadata?: MessageMetadata,
  ): Promise<void> {
    const updateData: Record<string, unknown> = {};

    if (profile.name != null) updateData.name = profile.name;
    if (profile.phone != null) updateData.phone = profile.phone;
    if (profile.gender != null) updateData.gender = profile.gender;
    if (profile.age != null) updateData.age = profile.age;
    if (profile.is_student != null) updateData.is_student = profile.is_student;
    if (profile.education != null) updateData.education = profile.education;
    if (profile.has_health_certificate != null)
      updateData.has_health_certificate = profile.has_health_certificate;
    if (metadata) updateData.message_metadata = metadata;

    if (Object.keys(updateData).length === 0) return;

    await this.upsertRow(corpId, userId, updateData);
  }

  // ==================== Summary 操作 ====================

  async getSummaryData(corpId: string, userId: string): Promise<SummaryData | null> {
    const row = await this.getRow(corpId, userId);
    return (row?.summary_data as SummaryData) ?? null;
  }

  /**
   * 追加一条摘要，自动执行分层压缩
   *
   * @param compressArchive 当 recent 超限时，由调用方传入压缩函数（LLM 调用）
   */
  async appendSummary(
    corpId: string,
    userId: string,
    entry: SummaryEntry,
    compressArchive?: (overflow: SummaryEntry[], existingArchive: string | null) => Promise<string>,
  ): Promise<void> {
    const existing = await this.getSummaryData(corpId, userId);
    const data: SummaryData = existing ?? { recent: [], archive: null };

    // 追加到头部（最新在前）
    data.recent.unshift(entry);

    // 分层压缩：超出上限时，移出最早的条目并压缩到 archive
    if (data.recent.length > MAX_RECENT_SUMMARIES && compressArchive) {
      const overflow = data.recent.splice(MAX_RECENT_SUMMARIES);
      try {
        data.archive = await compressArchive(overflow, data.archive);
      } catch (err) {
        this.logger.warn('摘要压缩失败，保留原始条目', err);
        // 压缩失败时，把溢出的条目放回去（降级：不压缩，下次再试）
        data.recent.push(...overflow);
      }
    } else if (data.recent.length > MAX_RECENT_SUMMARIES) {
      // 无压缩函数时，直接丢弃最早的
      data.recent = data.recent.slice(0, MAX_RECENT_SUMMARIES);
    }

    await this.upsertRow(corpId, userId, { summary_data: data });
  }

  // ==================== 旧接口（v1 兼容，Phase 6 删除） ====================

  async get(key: string): Promise<MemoryEntry | null> {
    const { corpId, userId } = this.parseProfileKey(key);
    const profile = await this.getProfile(corpId, userId);
    if (!profile) return null;
    return {
      key,
      content: profile as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    };
  }

  async set(key: string, content: Record<string, unknown>): Promise<void> {
    const { corpId, userId } = this.parseProfileKey(key);
    await this.upsertProfile(corpId, userId, content as Partial<UserProfile>);
  }

  async del(key: string): Promise<boolean> {
    const { corpId, userId } = this.parseProfileKey(key);
    await this.invalidateCache(corpId, userId);

    const client = this.supabase.getSupabaseClient();
    if (!client) return true;

    const { error } = await client.from(TABLE).delete().eq('corp_id', corpId).eq('user_id', userId);

    if (error) {
      this.logger.warn('删除长期记忆失败', error.message);
      return false;
    }
    return true;
  }

  // ==================== 内部方法 ====================

  private async getRow(corpId: string, userId: string): Promise<AgentMemoryRow | null> {
    // Redis 缓存优先
    const cacheKey = this.cacheKey(corpId, userId);
    const cached = await this.redis.get<AgentMemoryRow>(cacheKey);
    if (cached) return cached;

    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用');
      return null;
    }

    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .maybeSingle();

    if (error) {
      this.logger.warn('查询长期记忆失败', error.message);
      return null;
    }

    if (!data) return null;

    const row = data as AgentMemoryRow;
    await this.redis
      .setex(cacheKey, this.config.profileCacheTtl, row)
      .catch((err) => this.logger.warn('Redis 缓存回填失败', err));

    return row;
  }

  private async upsertRow(
    corpId: string,
    userId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，长期记忆未持久化');
      return;
    }

    const existing = await client
      .from(TABLE)
      .select('id')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .maybeSingle();

    const updateFields = { ...fields, updated_at: new Date().toISOString() };

    if (existing.data) {
      const { error } = await client.from(TABLE).update(updateFields).eq('id', existing.data.id);
      if (error) this.logger.warn('更新长期记忆失败', error.message);
    } else {
      const { error } = await client
        .from(TABLE)
        .insert({ corp_id: corpId, user_id: userId, ...updateFields });
      if (error) this.logger.warn('插入长期记忆失败', error.message);
    }

    await this.invalidateCache(corpId, userId);
  }

  private async invalidateCache(corpId: string, userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(corpId, userId)).catch(() => {});
  }

  private cacheKey(corpId: string, userId: string): string {
    return `profile:${corpId}:${userId}`;
  }

  private parseProfileKey(key: string): { corpId: string; userId: string } {
    const parts = key.replace(/^profile:/, '').split(':');
    return { corpId: parts[0] ?? '', userId: parts[1] ?? '' };
  }
}
