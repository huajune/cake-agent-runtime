import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisService } from '@infra/redis/redis.service';
import { MemoryConfig } from '../memory.config';
import type {
  UserProfile,
  UserProfileMeta,
  ProfileFieldMeta,
  SummaryData,
  SummaryEntry,
  MessageMetadata,
  AgentMemoryRow,
} from '../types/long-term.types';
import { MAX_RECENT_SUMMARIES, USER_PROFILE_FIELD_KEYS } from '../types/long-term.types';
import type { MemoryEntry, MemoryStore } from './store.types';

const TABLE = 'agent_memories';

function normalizeSummaryData(data: SummaryData | null | undefined): SummaryData | null {
  if (!data) return null;
  return {
    recent: data.recent ?? [],
    archive: data.archive ?? null,
    lastSettledMessageAt: data.lastSettledMessageAt ?? null,
  };
}

/**
 * Supabase 存储后端 — 长期记忆（每用户一行）
 *
 * 表结构：Profile 平铺列 + summary_data jsonb + message_metadata jsonb
 * 唯一约束 (corp_id, user_id)，每用户一行。
 * Redis 2h 缓存整行数据。
 * Supabase 不可用时 graceful 降级。
 *
 * 当前这套记忆结构对表结构没有新增列要求：
 * - `summary_data` 里的 `lastSettledMessageAt` 直接放在 jsonb 中
 * - 开发阶段允许旧 json 结构自然被新写入覆盖，不做额外迁移兼容
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

  /**
   * 写入 Profile 字段并同时记录来源元数据（profile_fields_meta）。
   *
   * 置信度守卫由 DB 端 RPC `upsert_profile_with_confidence_guard` 原子保证：
   * SELECT ... FOR UPDATE 行锁 → 读 existing meta → 逐字段比较 confidence →
   * high 不被非 high 覆盖 → 单事务写入。
   *
   * 解决的竞态：booking（fire-and-forget, high）与 settlement（async, medium）
   * 交错时，应用层 read-then-write 无法保证 high 不被覆盖。
   */
  async upsertProfileWithMeta(
    corpId: string,
    userId: string,
    profile: Partial<UserProfile>,
    meta: UserProfileMeta,
    metadata?: MessageMetadata,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，长期记忆未持久化');
      return;
    }

    const profileJson: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(profile)) {
      if (value != null) profileJson[key] = value;
    }
    const mergedMeta = this.withDefaultProfileMeta(profileJson, meta, {
      source: 'enrichment',
      confidence: 'medium',
    });
    if (Object.keys(profileJson).length === 0 && Object.keys(mergedMeta).length === 0) return;

    const { data, error } = await client.rpc('upsert_profile_with_confidence_guard', {
      p_corp_id: corpId,
      p_user_id: userId,
      p_profile: profileJson,
      p_meta: mergedMeta,
      p_message_metadata: metadata ?? null,
    });

    if (error) {
      this.logger.warn('[upsertProfileWithMeta] RPC 失败', error.message);
      return;
    }

    const result = data as { written_fields: string[]; skipped_fields: string[] } | null;
    if (result?.skipped_fields?.length) {
      this.logger.log(
        `[upsertProfileWithMeta] 置信度守卫：跳过 ${result.skipped_fields.join(',')}（已有 high，incoming 非 high）`,
      );
    }

    await this.invalidateCache(corpId, userId);
  }

  // ==================== Summary 操作 ====================

  async getSummaryData(corpId: string, userId: string): Promise<SummaryData | null> {
    const row = await this.getRow(corpId, userId);
    return normalizeSummaryData((row?.summary_data as SummaryData | null) ?? null);
  }

  /**
   * 原子追加一条摘要（DB 端 RPC 行锁），自动执行分层压缩。
   *
   * Phase 1: RPC `append_summary_atomic` 在行锁内追加 entry 到 recent 头部，
   *          超限时返回溢出条目但不压缩（压缩需 LLM，不能在 DB 事务里做）。
   * Phase 2: 若有溢出且提供了 compressArchive，在应用层压缩后回写 archive。
   */
  async appendSummary(
    corpId: string,
    userId: string,
    entry: SummaryEntry,
    options?: {
      lastSettledMessageAt?: string | null;
      compressArchive?: (
        overflow: SummaryEntry[],
        existingArchive: string | null,
      ) => Promise<string>;
    },
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，appendSummary 跳过');
      return;
    }

    const { data: rpcResult, error } = await client.rpc('append_summary_atomic', {
      p_corp_id: corpId,
      p_user_id: userId,
      p_entry: JSON.stringify(entry),
      p_last_settled_message_at: options?.lastSettledMessageAt ?? null,
      p_max_recent: MAX_RECENT_SUMMARIES,
    });

    if (error) {
      this.logger.warn('[appendSummary] RPC 失败，降级到应用层写入', error.message);
      await this.appendSummaryFallback(corpId, userId, entry, options);
      return;
    }

    await this.invalidateCache(corpId, userId);

    const result = rpcResult as { overflow: SummaryEntry[]; recentCount: number } | null;
    if (result?.overflow?.length && options?.compressArchive) {
      try {
        const summaryData = await this.getSummaryData(corpId, userId);
        const archive = await options.compressArchive(
          result.overflow,
          summaryData?.archive ?? null,
        );
        await this.upsertRow(corpId, userId, {
          summary_data: {
            ...(summaryData ?? { recent: [], lastSettledMessageAt: null }),
            archive,
          },
        });
      } catch (err) {
        this.logger.warn('摘要压缩失败，溢出条目将在下次压缩', err);
      }
    }
  }

  /** RPC 不可用时的降级路径（应用层 read-then-write，非原子）。 */
  private async appendSummaryFallback(
    corpId: string,
    userId: string,
    entry: SummaryEntry,
    options?: {
      lastSettledMessageAt?: string | null;
      compressArchive?: (
        overflow: SummaryEntry[],
        existingArchive: string | null,
      ) => Promise<string>;
    },
  ): Promise<void> {
    const existing = await this.getSummaryData(corpId, userId);
    const data: SummaryData = existing ?? {
      recent: [],
      archive: null,
      lastSettledMessageAt: null,
    };

    data.recent.unshift(entry);

    if (data.recent.length > MAX_RECENT_SUMMARIES && options?.compressArchive) {
      const overflow = data.recent.splice(MAX_RECENT_SUMMARIES);
      try {
        data.archive = await options.compressArchive(overflow, data.archive);
      } catch (err) {
        this.logger.warn('摘要压缩失败，保留原始条目', err);
        data.recent.push(...overflow);
      }
    } else if (data.recent.length > MAX_RECENT_SUMMARIES) {
      data.recent = data.recent.slice(0, MAX_RECENT_SUMMARIES);
    }

    if (options?.lastSettledMessageAt !== undefined) {
      data.lastSettledMessageAt = options.lastSettledMessageAt;
    }

    await this.upsertRow(corpId, userId, { summary_data: data });
  }

  async markLastSettledMessageAt(
    corpId: string,
    userId: string,
    lastSettledMessageAt: string,
  ): Promise<void> {
    const existing = await this.getSummaryData(corpId, userId);
    const data: SummaryData = existing ?? {
      recent: [],
      archive: null,
      lastSettledMessageAt: null,
    };

    data.lastSettledMessageAt = lastSettledMessageAt;
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
    await this.upsertProfileWithMeta(corpId, userId, content as Partial<UserProfile>, {});
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
      .setex(cacheKey, this.config.longTermCacheTtl, row)
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

    const { error } = await client
      .from(TABLE)
      .upsert(
        { corp_id: corpId, user_id: userId, ...fields, updated_at: new Date().toISOString() },
        { onConflict: 'corp_id,user_id' },
      );

    if (error) this.logger.warn('upsert 长期记忆失败', error.message);

    await this.invalidateCache(corpId, userId);
  }

  private async invalidateCache(corpId: string, userId: string): Promise<void> {
    await this.redis.del(this.cacheKey(corpId, userId)).catch(() => {});
  }

  private cacheKey(corpId: string, userId: string): string {
    return `profile:${corpId}:${userId}`;
  }

  private withDefaultProfileMeta(
    profileJson: Record<string, unknown>,
    meta: UserProfileMeta,
    defaults: Pick<ProfileFieldMeta, 'source' | 'confidence'>,
  ): UserProfileMeta {
    const mergedMeta: UserProfileMeta = { ...meta };
    const writtenAt = new Date().toISOString();

    for (const key of USER_PROFILE_FIELD_KEYS) {
      if (profileJson[key] !== undefined && !mergedMeta[key]) {
        mergedMeta[key] = { ...defaults, writtenAt };
      }
    }

    return mergedMeta;
  }

  private parseProfileKey(key: string): { corpId: string; userId: string } {
    const parts = key.replace(/^profile:/, '').split(':');
    return { corpId: parts[0] ?? '', userId: parts[1] ?? '' };
  }
}
