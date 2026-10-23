import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisService } from '@infra/redis/redis.service';
import { MemoryConfig } from '../memory.config';
import type { z } from 'zod';
import type { CandidateFactField, CandidateFactProducer } from '@resolution/candidate/types';
import { canonicalizeCandidateFieldValue } from '@resolution/candidate/value-shape';
import { normalizeHealthCertificateState } from '@resolution/candidate/health-certificate-state';
import { truncateEvidence } from '../fact-evidence';
import { isExpiredTemporalFact } from '../temporal-facts';
import { isValidSummaryEntry } from '../memory-integrity';
import type {
  UserProfile,
  UserProfileFactValue,
  UserProfileFacts,
  UserProfileFieldKey,
  ProfileFactConfidence,
  SummaryEntry,
  ConsolidationWatermarks,
  MessageMetadata,
  ActiveBookingEntry,
  ActiveBookingState,
  JobIntentFacts,
} from '../long-term/long-term.types';
import {
  createEmptyUserProfileFacts,
  isUserProfileFactValue,
  LONG_TERM_JOB_INTENT_FIELD_KEYS,
  MAX_SESSION_SUMMARIES,
  UserProfileFactValueSchema,
  userProfileFactValue,
  USER_PROFILE_FIELD_KEYS,
} from '../long-term/long-term.types';
import type { MemoryEntry, MemoryStore } from './store.types';

const TABLE = 'agent_long_term_memories';

export interface BookingProjectionOptions {
  strict?: boolean;
  occurredAt?: string;
  assertOwned?: () => Promise<void>;
}

/** Supabase 存储适配层的行投影；数据库行不是 LongTermMemory 召回契约。 */
interface AgentLongTermMemoryRow {
  id: string;
  corp_id: string;
  user_id: string;
  bot_user_id?: string | null;
  semantic_profile?: UserProfileFacts | null;
  semantic_job_intent?: JobIntentFacts | null;
  episodic_session_summaries?: SummaryEntry[] | null;
  consolidation_watermarks?: ConsolidationWatermarks | null;
  message_metadata?: MessageMetadata | null;
  active_booking?: ActiveBookingState | null;
  created_at: string;
  updated_at: string;
}

const EMPTY_CONSOLIDATION_WATERMARKS: ConsolidationWatermarks = {
  bySession: {},
  lastSettledMessageAt: null,
};

function toSummaryEntries(value: unknown): SummaryEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isValidSummaryEntry)
    .sort((a, b) => Date.parse(a.endTime) - Date.parse(b.endTime));
}

function isCanonicalWatermarks(value: unknown): value is ConsolidationWatermarks {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const raw = value as Record<string, unknown>;
  return (
    Object.keys(raw).every((key) => key === 'bySession' || key === 'lastSettledMessageAt') &&
    Boolean(raw.bySession) &&
    typeof raw.bySession === 'object' &&
    !Array.isArray(raw.bySession) &&
    Object.values(raw.bySession).every((timestamp) => typeof timestamp === 'string') &&
    (raw.lastSettledMessageAt === null || typeof raw.lastSettledMessageAt === 'string')
  );
}

interface EpisodicState {
  sessionSummaries: SummaryEntry[] | null;
  consolidationWatermarks: ConsolidationWatermarks;
}

/**
 * episodic 读边界：列已由迁移 20260911120000 归一为裸 `SummaryEntry[]` + 独立水位列，
 * 这里只做形状校验与 20 段封顶（append RPC 已在写侧封顶，读侧不再写回）。
 */
function readEpisodicState(row: AgentLongTermMemoryRow | null): EpisodicState {
  if (!row) {
    return {
      sessionSummaries: null,
      consolidationWatermarks: { ...EMPTY_CONSOLIDATION_WATERMARKS, bySession: {} },
    };
  }
  const summaryValue = row.episodic_session_summaries;
  const watermarks = isCanonicalWatermarks(row.consolidation_watermarks)
    ? row.consolidation_watermarks
    : EMPTY_CONSOLIDATION_WATERMARKS;
  return {
    sessionSummaries: Array.isArray(summaryValue)
      ? toSummaryEntries(summaryValue).slice(-MAX_SESSION_SUMMARIES)
      : null,
    consolidationWatermarks: {
      bySession: { ...watermarks.bySession },
      lastSettledMessageAt: watermarks.lastSettledMessageAt,
    },
  };
}

/** 长期档案里需要规范形的数值字段 → 候选人字段词汇。 */
const PROFILE_NUMERIC_FIELDS: Partial<Record<UserProfileFieldKey, CandidateFactField>> = {
  age: 'age',
  height: 'height',
  weight: 'weight',
};

function normalizeProfileFacts(data: UserProfileFacts | null | undefined): UserProfileFacts | null {
  if (!data) return null;

  const facts = createEmptyUserProfileFacts();
  let hasValue = false;
  const raw = data as Record<string, unknown>;

  for (const key of USER_PROFILE_FIELD_KEYS) {
    const parsed = UserProfileFactValueSchema.safeParse(raw[key]);
    if (!parsed.success) continue;
    const normalized = normalizeProfileFactValue(key, parsed.data);
    if (!normalized) continue;
    (facts as Record<string, unknown>)[key] = normalized;
    hasValue = true;
  }

  return hasValue ? facts : null;
}

/**
 * 读边界规范形：存量档案里有旧提取路径写下的 "20岁" / "38周岁" / "75年" / 昵称串 /
 * 空串，以及斤当 kg 的体重（09-02 核对：994 条年龄 8 条脏值，13 条体重 4 条 ≥114）。
 * 数值字段按 canonicalizeCandidateFieldValue 归一，归不出形态的直接丢弃；其余字段只拦空串。
 */
function normalizeProfileFactValue(
  key: UserProfileFieldKey,
  fact: z.infer<typeof UserProfileFactValueSchema>,
): z.infer<typeof UserProfileFactValueSchema> | null {
  if (typeof fact.value === 'string' && fact.value.trim() === '') return null;
  if (key === 'has_health_certificate') {
    const value = normalizeHealthCertificateState(fact.value);
    return value === null ? null : { ...fact, value };
  }
  const numericField = PROFILE_NUMERIC_FIELDS[key];
  if (!numericField) return fact;
  const canonical = canonicalizeCandidateFieldValue(numericField, fact.value);
  if (canonical === null) return null;
  return canonical === fact.value ? fact : { ...fact, value: canonical };
}

function normalizeJobIntentFacts(data: JobIntentFacts | null | undefined): JobIntentFacts | null {
  if (!data || typeof data !== 'object') return null;
  const facts: JobIntentFacts = {};
  const raw = data as Record<string, unknown>;
  for (const key of LONG_TERM_JOB_INTENT_FIELD_KEYS) {
    const parsed = UserProfileFactValueSchema.safeParse(raw[key]);
    if (
      parsed.success &&
      !isExpiredTemporalFact(key, parsed.data as UserProfileFactValue<unknown>)
    ) {
      facts[key] = parsed.data as UserProfileFactValue<unknown>;
    }
  }
  return Object.keys(facts).length > 0 ? facts : null;
}

function normalizeActiveBookingEntry(value: unknown): ActiveBookingEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const workOrderId =
    typeof raw.work_order_id === 'number'
      ? raw.work_order_id
      : typeof raw.work_order_id === 'string' && /^\d+$/.test(raw.work_order_id)
        ? Number(raw.work_order_id)
        : null;
  if (workOrderId == null) return null;

  const linkedAt = typeof raw.linked_at === 'string' ? raw.linked_at : new Date(0).toISOString();
  const jobId =
    typeof raw.job_id === 'number'
      ? raw.job_id
      : typeof raw.job_id === 'string' && /^\d+$/.test(raw.job_id)
        ? Number(raw.job_id)
        : null;

  const interviewTime =
    typeof raw.interview_time === 'string' && raw.interview_time.trim() ? raw.interview_time : null;

  return {
    work_order_id: workOrderId,
    linked_at: linkedAt,
    job_id: jobId,
    ...(interviewTime ? { interview_time: interviewTime } : {}),
  };
}

function normalizeActiveBookings(value: unknown): ActiveBookingEntry[] {
  const raw = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  const entries = [...(Array.isArray(raw?.bookings) ? raw.bookings : []), value];
  const byWorkOrder = new Map<number, ActiveBookingEntry>();

  for (const entry of entries) {
    const booking = normalizeActiveBookingEntry(entry);
    if (!booking) continue;
    const existing = byWorkOrder.get(booking.work_order_id);
    byWorkOrder.set(booking.work_order_id, {
      ...existing,
      ...booking,
    });
  }

  return Array.from(byWorkOrder.values()).sort((a, b) => {
    const bMs = Date.parse(b.linked_at);
    const aMs = Date.parse(a.linked_at);
    return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
  });
}

/**
 * Supabase 存储后端 — 长期记忆（候选人 × 托管账号关系一行）
 *
 * 表结构：semantic_profile / semantic_job_intent / episodic_session_summaries /
 * consolidation_watermarks / message_metadata / active_booking（均 jsonb）
 * 长期记忆唯一约束 (corp_id, user_id, bot_user_id)。bot_user_id 使用稳定 wecomUserId；
 * bot_user_id IS NULL 的存量行只承载冻结旧记忆与 active_booking，不进入长期召回。
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

  async getProfile(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<UserProfileFacts | null> {
    const row = await this.getRow(corpId, userId, botUserId);
    if (!row) return null;
    return normalizeProfileFacts(row.semantic_profile ?? null);
  }

  /**
   * 写入 Profile facts。每个字段值自身携带 value/confidence/source/evidence/updatedAt。
   *
   * 置信度守卫由 DB 端 RPC `upsert_long_term_profile_facts` 原子保证：
   * 已有 high 时，incoming 非 high 不得覆盖。
   *
   * 可选同时携带 jobIntentFacts（沉淀路径）：两列在同一 RPC 事务/行锁内写入，
   * 消除"profile 落库而意向丢失"的半写状态。preference 按字段时间合并，显式墓碑清空。
   */
  async upsertProfileFacts(
    corpId: string,
    userId: string,
    botUserId: string,
    profileFacts: Partial<UserProfileFacts>,
    metadata?: MessageMetadata,
    jobIntentFacts?: JobIntentFacts,
    options?: { strict?: boolean },
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      if (options?.strict) throw new Error('memory_profile_store_unavailable');
      this.logger.warn('Supabase 不可用，长期记忆未持久化');
      return;
    }

    const profileFactsJson: Record<string, unknown> = {};
    for (const key of USER_PROFILE_FIELD_KEYS) {
      const fact = profileFacts[key];
      if (isUserProfileFactValue(fact) && fact.value !== null && fact.value !== undefined) {
        const value =
          key === 'has_health_certificate'
            ? normalizeHealthCertificateState(fact.value)
            : fact.value;
        if (value === null) continue;
        profileFactsJson[key] = { ...fact, value, evidence: truncateEvidence(fact.evidence) };
      }
    }
    // 意向 value=null 是显式清空墓碑，截断 evidence 时不得过滤掉。
    const normalizedIntent = jobIntentFacts
      ? Object.fromEntries(
          Object.entries(jobIntentFacts).map(([key, fact]) => [
            key,
            { ...fact, evidence: truncateEvidence(fact.evidence) },
          ]),
        )
      : null;
    const hasPreferences = Boolean(normalizedIntent && Object.keys(normalizedIntent).length > 0);
    if (Object.keys(profileFactsJson).length === 0 && !metadata && !hasPreferences) return;

    const request = client.rpc(
      options?.strict ? 'upsert_booking_profile_facts' : 'upsert_long_term_profile_facts',
      {
        p_corp_id: corpId,
        p_user_id: userId,
        p_bot_user_id: botUserId,
        p_profile_facts: profileFactsJson,
        p_message_metadata: metadata ?? null,
        p_preference_facts: hasPreferences ? normalizedIntent : null,
      },
    );
    const { data, error } = await (options?.strict
      ? request.abortSignal(AbortSignal.timeout(5000))
      : request);

    if (error) {
      this.logger.warn('[upsertProfileFacts] RPC 失败', error.message);
      throw error;
    }

    const result = data as { written_fields: string[]; skipped_fields: string[] } | null;
    if (result?.skipped_fields?.length) {
      this.logger.log(
        `[upsertProfileFacts] 置信度守卫：跳过 ${result.skipped_fields.join(',')}（已有 high，incoming 非 high）`,
      );
    }

    if (options?.strict) await this.redis.del(this.cacheKey(corpId, userId, botUserId));
    else await this.invalidateCache(corpId, userId, botUserId);
  }

  // ==================== Preference 操作 ====================

  /** 读取长期求职意向（consolidation 沉淀的跨会话偏好快照）。 */
  async getPreferenceFacts(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<JobIntentFacts | null> {
    const row = await this.getRow(corpId, userId, botUserId);
    return normalizeJobIntentFacts(row?.semantic_job_intent ?? null);
  }

  // ==================== Summary 操作 ====================

  async getSessionSummaries(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<SummaryEntry[] | null> {
    return readEpisodicState(await this.getRow(corpId, userId, botUserId)).sessionSummaries;
  }

  async getConsolidationWatermarks(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<ConsolidationWatermarks> {
    return readEpisodicState(await this.getRow(corpId, userId, botUserId)).consolidationWatermarks;
  }

  /** 原子追加一条 episode 并推进独立水位；DB 端同一 UPDATE 写两列。 */
  async appendSummary(
    corpId: string,
    userId: string,
    botUserId: string,
    entry: SummaryEntry,
    options?: {
      lastSettledMessageAt?: string | null;
      /** 沉淀边界的会话维度 key；提供时同步写 consolidation_watermarks.bySession。 */
      sessionId?: string | null;
    },
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      throw new Error('memory_summary_store_unavailable');
    }

    const { error } = await client.rpc('append_long_term_summary_atomic', {
      p_corp_id: corpId,
      p_user_id: userId,
      p_bot_user_id: botUserId,
      p_entry: entry,
      p_last_settled_message_at: options?.lastSettledMessageAt ?? null,
      p_max_session_summaries: MAX_SESSION_SUMMARIES,
      p_session_id: options?.sessionId ?? null,
    });

    if (error) {
      this.logger.warn('[appendSummary] RPC 失败', error.message);
      throw error;
    }

    await this.invalidateCache(corpId, userId, botUserId);
  }

  async markLastSettledMessageAt(
    corpId: string,
    userId: string,
    botUserId: string,
    lastSettledMessageAt: string,
    sessionId?: string | null,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) throw new Error('memory_watermark_store_unavailable');

    const { error } = await client.rpc('mark_long_term_settled_boundary', {
      p_corp_id: corpId,
      p_user_id: userId,
      p_bot_user_id: botUserId,
      p_last_settled_message_at: lastSettledMessageAt,
      p_session_id: sessionId ?? null,
    });
    if (error) {
      this.logger.warn('[markLastSettledMessageAt] RPC 失败', error.message);
      throw error;
    }
    await this.invalidateCache(corpId, userId, botUserId);
  }

  // ==================== active_booking 操作 ====================

  /**
   * 读取候选人当前有效/待处理预约工单列表（按 linked_at 倒序，[0] 即最近一笔）。
   *
   * 单数关系由 `bookings[0] ?? null` 派生；需要“最近一笔”的调用方直接取 `[0]`。
   */
  async getActiveBookings(
    corpId: string,
    userId: string,
    options?: { bypassCache?: boolean; strict?: boolean },
  ): Promise<ActiveBookingEntry[]> {
    const row = await this.getActiveBookingRow(corpId, userId, options);
    return normalizeActiveBookings(row?.active_booking ?? null);
  }

  /** Atomic event-versioned projection; false means a later local fact already superseded this event. */
  async setActiveBooking(
    corpId: string,
    userId: string,
    workOrderId: number,
    metadata?: Pick<ActiveBookingEntry, 'job_id' | 'interview_time'>,
    options?: BookingProjectionOptions,
  ): Promise<boolean> {
    return this.applyBookingProjection(corpId, userId, 'set', workOrderId, metadata, options);
  }

  async clearActiveBooking(
    corpId: string,
    userId: string,
    expectedWorkOrderId?: number,
    options?: BookingProjectionOptions,
  ): Promise<boolean> {
    return this.applyBookingProjection(
      corpId,
      userId,
      'clear',
      expectedWorkOrderId,
      undefined,
      options,
    );
  }

  private async applyBookingProjection(
    corpId: string,
    userId: string,
    operation: 'set' | 'clear',
    workOrderId?: number,
    metadata?: Pick<ActiveBookingEntry, 'job_id' | 'interview_time'>,
    options?: BookingProjectionOptions,
  ): Promise<boolean> {
    const client = this.supabase.getSupabaseClient();
    if (!client) throw new Error('active_booking_store_unavailable');
    // Check as close to dispatch as possible. The SQL version fence, not this Redis check,
    // protects against a request completing after its caller lost the conversation lease.
    await options?.assertOwned?.();
    const { data, error } = await client
      .rpc('apply_active_booking_projection', {
        p_corp_id: corpId,
        p_user_id: userId,
        p_operation: operation,
        p_work_order_id: workOrderId ?? null,
        p_occurred_at: options?.occurredAt ?? new Date().toISOString(),
        p_job_id: metadata?.job_id ?? null,
        p_interview_time: metadata?.interview_time ?? null,
      })
      .abortSignal(AbortSignal.timeout(5000));
    if (error) throw error;
    if (options?.strict) await this.redis.del(`active-booking:${corpId}:${userId}`);
    else await this.redis.del(`active-booking:${corpId}:${userId}`).catch(() => {});
    if (!data || typeof (data as { superseded?: unknown }).superseded !== 'boolean')
      throw new Error('active_booking_projection_result_unavailable');
    return (data as { superseded: boolean }).superseded === false;
  }

  // ==================== MemoryStore 通用接口适配 ====================

  // LongTermService 生产路径使用上方的领域化方法；get/set/del 保留为
  // MemoryStore 契约与管理操作的窄适配层，不是另一条长期记忆读写链。

  async get(key: string): Promise<MemoryEntry | null> {
    const { corpId, userId, botUserId } = this.parseProfileKey(key);
    if (!botUserId) return null;
    const profile = await this.getProfile(corpId, userId, botUserId);
    if (!profile) return null;
    return {
      key,
      content: profile as unknown as Record<string, unknown>,
      updatedAt: new Date().toISOString(),
    };
  }

  async set(key: string, content: Record<string, unknown>): Promise<void> {
    const { corpId, userId, botUserId } = this.parseProfileKey(key);
    if (!botUserId) return;
    const profileFacts = this.buildProfileFactsFromPlain(content as Partial<UserProfile>, {
      source: 'system',
      confidence: 'medium',
      evidence: '外部补充字段写入长期档案',
    });
    await this.upsertProfileFacts(corpId, userId, botUserId, profileFacts);
  }

  async del(key: string): Promise<boolean> {
    const { corpId, userId, botUserId } = this.parseProfileKey(key);
    if (!botUserId) return false;
    await this.invalidateCache(corpId, userId, botUserId);

    const client = this.supabase.getSupabaseClient();
    if (!client) return true;

    const { error } = await client
      .from(TABLE)
      .delete()
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .eq('bot_user_id', botUserId);

    if (error) {
      this.logger.warn('删除长期记忆失败', error.message);
      return false;
    }
    return true;
  }

  // ==================== 内部方法 ====================

  private async getRow(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<AgentLongTermMemoryRow | null> {
    // Redis 缓存优先
    const cacheKey = this.cacheKey(corpId, userId, botUserId);
    const cached = await this.redis.get<AgentLongTermMemoryRow>(cacheKey);
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
      .eq('bot_user_id', botUserId)
      .maybeSingle();

    if (error) {
      this.logger.warn('查询长期记忆失败', error.message);
      return null;
    }

    if (!data) return null;

    const row = data as AgentLongTermMemoryRow;
    await this.redis
      .setex(cacheKey, this.config.longTermCacheTtl, row)
      .catch((err) => this.logger.warn('Redis 缓存回填失败', err));

    return row;
  }

  private async upsertRow(
    corpId: string,
    userId: string,
    botUserId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，长期记忆未持久化');
      return;
    }

    const { error } = await client.from(TABLE).upsert(
      {
        corp_id: corpId,
        user_id: userId,
        bot_user_id: botUserId,
        ...fields,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'corp_id,user_id,bot_user_id' },
    );

    if (error) {
      this.logger.warn('upsert 长期记忆失败', error.message);
      throw error;
    }

    await this.invalidateCache(corpId, userId, botUserId);
  }

  /**
   * active_booking 冻结区继续按 (corpId, userId) 读写 bot_user_id IS NULL 的兼容行。
   * bot 关系行绝不复制/承载该列，避免账号维改造改变工单指针的共享口径。
   */
  private async getActiveBookingRow(
    corpId: string,
    userId: string,
    options?: { bypassCache?: boolean; strict?: boolean },
  ): Promise<AgentLongTermMemoryRow | null> {
    const cacheKey = `active-booking:${corpId}:${userId}`;
    const cached =
      options?.bypassCache || options?.strict
        ? null
        : await this.redis.get<AgentLongTermMemoryRow>(cacheKey);
    if (cached) return cached;

    const client = this.supabase.getSupabaseClient();
    if (!client) throw new Error('active_booking_store_unavailable');
    const request = client
      .from(TABLE)
      .select('*')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .is('bot_user_id', null);
    const { data, error } = await (
      options?.strict ? request.abortSignal(AbortSignal.timeout(5000)) : request
    ).maybeSingle();
    if (error) {
      throw new Error(`active_booking_read_failed: ${error.message}`);
    }
    if (!data) return null;

    const row = data as AgentLongTermMemoryRow;
    await this.redis
      .setex(cacheKey, this.config.longTermCacheTtl, row)
      .catch((error_) => this.logger.warn('active_booking 缓存回填失败', error_));
    return row;
  }

  private async invalidateCache(corpId: string, userId: string, botUserId: string): Promise<void> {
    await this.redis.del(this.cacheKey(corpId, userId, botUserId)).catch(() => {});
  }

  private cacheKey(corpId: string, userId: string, botUserId: string): string {
    return `long-term:${corpId}:${userId}:${botUserId}`;
  }

  private buildProfileFactsFromPlain(
    profile: Partial<UserProfile>,
    defaults: {
      source: CandidateFactProducer;
      confidence: ProfileFactConfidence;
      evidence: string;
    },
  ): Partial<UserProfileFacts> {
    const facts: Partial<UserProfileFacts> = {};
    const updatedAt = new Date().toISOString();
    for (const key of USER_PROFILE_FIELD_KEYS) {
      const value = profile[key];
      if (value !== null && value !== undefined) {
        (facts as Record<string, unknown>)[key] = userProfileFactValue(value, {
          ...defaults,
          updatedAt,
        });
      }
    }
    return facts;
  }

  private parseProfileKey(key: string): { corpId: string; userId: string; botUserId: string } {
    const parts = key.replace(/^(profile|long-term):/, '').split(':');
    return {
      corpId: parts[0] ?? '',
      userId: parts[1] ?? '',
      botUserId: parts.slice(2).join(':'),
    };
  }
}
