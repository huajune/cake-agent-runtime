import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RedisService } from '@infra/redis/redis.service';
import { MemoryConfig } from '../memory.config';
import type { CandidateFactProducer } from '@resolution/candidate/types';
import type {
  UserProfile,
  UserProfileFactValue,
  UserProfileFacts,
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

interface NormalizedEpisodicState {
  sessionSummaries: SummaryEntry[] | null;
  consolidationWatermarks: ConsolidationWatermarks;
  needsMigration: boolean;
}

function toStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].trim().length > 0,
    ),
  );
}

function toSummaryEntries(value: unknown): SummaryEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is SummaryEntry =>
      Boolean(entry) && typeof entry === 'object' && typeof entry.summary === 'string',
  );
}

/** 旧 archive 没有逐段标识符；用空标识符补齐既有 SummaryEntry 形状。 */
function legacyArchiveEntries(value: unknown): SummaryEntry[] {
  const segments = (typeof value === 'string' ? [value] : Array.isArray(value) ? value : [])
    .filter((segment): segment is string => typeof segment === 'string')
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.map((summary) => ({
    summary,
    sessionId: '',
    startTime: '',
    endTime: '',
  }));
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

function normalizeEpisodicState(row: AgentLongTermMemoryRow): NormalizedEpisodicState {
  const summaryValue = row.episodic_session_summaries;
  const canonicalSummaries = Array.isArray(summaryValue);
  const rawSummary =
    summaryValue && typeof summaryValue === 'object' && !canonicalSummaries
      ? (summaryValue as unknown as Record<string, unknown>)
      : null;

  let sessionSummaries: SummaryEntry[] | null = null;
  let summaryNeedsMigration = false;
  if (canonicalSummaries) {
    sessionSummaries = toSummaryEntries(summaryValue).slice(-MAX_SESSION_SUMMARIES);
    summaryNeedsMigration = sessionSummaries.length !== summaryValue.length;
  } else if (rawSummary) {
    // 旧 recent 以新到旧排列；裸数组统一为旧到新，archive 旧段置于头部。
    const recent = toSummaryEntries(rawSummary.recent).reverse();
    sessionSummaries = [...legacyArchiveEntries(rawSummary.archive), ...recent].slice(
      -MAX_SESSION_SUMMARIES,
    );
    summaryNeedsMigration = true;
  }

  const rawWatermarks = row.consolidation_watermarks;
  const canonicalWatermarks = isCanonicalWatermarks(rawWatermarks);
  const currentWatermarks = canonicalWatermarks ? rawWatermarks : EMPTY_CONSOLIDATION_WATERMARKS;
  const legacyBySession = toStringRecord(rawSummary?.lastSettledBySession);
  const legacyFallback =
    typeof rawSummary?.lastSettledMessageAt === 'string' ? rawSummary.lastSettledMessageAt : null;
  const consolidationWatermarks: ConsolidationWatermarks = {
    bySession: { ...legacyBySession, ...currentWatermarks.bySession },
    lastSettledMessageAt: currentWatermarks.lastSettledMessageAt ?? legacyFallback,
  };

  return {
    sessionSummaries,
    consolidationWatermarks,
    needsMigration:
      summaryNeedsMigration ||
      (!canonicalWatermarks && Boolean(rawSummary)) ||
      Object.keys(legacyBySession).length > 0 ||
      legacyFallback !== null,
  };
}

function normalizeProfileFacts(data: UserProfileFacts | null | undefined): UserProfileFacts | null {
  if (!data) return null;

  const facts = createEmptyUserProfileFacts();
  let hasValue = false;
  const raw = data as Record<string, unknown>;

  for (const key of USER_PROFILE_FIELD_KEYS) {
    const parsed = UserProfileFactValueSchema.safeParse(raw[key]);
    if (parsed.success) {
      (facts as Record<string, unknown>)[key] = parsed.data;
      hasValue = true;
    }
  }

  return hasValue ? facts : null;
}

function normalizeJobIntentFacts(data: JobIntentFacts | null | undefined): JobIntentFacts | null {
  if (!data || typeof data !== 'object') return null;
  const facts: JobIntentFacts = {};
  const raw = data as Record<string, unknown>;
  for (const key of LONG_TERM_JOB_INTENT_FIELD_KEYS) {
    const parsed = UserProfileFactValueSchema.safeParse(raw[key]);
    if (parsed.success) facts[key] = parsed.data as UserProfileFactValue<unknown>;
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

  return {
    work_order_id: workOrderId,
    linked_at: linkedAt,
    job_id: jobId,
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
 * 组装 active_booking 列：顶层是最近一笔的镜像（老行 JSONB 形态兼容），bookings 是全量列表。
 *
 * 入参恒为 normalizeActiveBookingEntry 产出的三字段对象，原实现里那次
 * `.map(({ bookings: _bookings, ...b }) => b)` 剥离在运行时必然是恒等映射；
 * `ActiveBookingEntry` 已不含 bookings，因此不需要再剥离递归字段；落库 JSONB 形态不变。
 */
function buildActiveBookingState(bookings: ActiveBookingEntry[]): ActiveBookingState | null {
  const [latest, ...rest] = bookings;
  if (!latest) return null;
  return { ...latest, bookings: [latest, ...rest] };
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
   * 消除"profile 落库而意向丢失"的半写状态。preference 维持快照式整列覆盖语义。
   */
  async upsertProfileFacts(
    corpId: string,
    userId: string,
    botUserId: string,
    profileFacts: Partial<UserProfileFacts>,
    metadata?: MessageMetadata,
    jobIntentFacts?: JobIntentFacts,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，长期记忆未持久化');
      return;
    }

    const profileFactsJson: Record<string, unknown> = {};
    for (const key of USER_PROFILE_FIELD_KEYS) {
      const fact = profileFacts[key];
      if (isUserProfileFactValue(fact) && fact.value !== null && fact.value !== undefined) {
        profileFactsJson[key] = fact;
      }
    }
    const hasPreferences = Boolean(jobIntentFacts && Object.keys(jobIntentFacts).length > 0);
    if (Object.keys(profileFactsJson).length === 0 && !metadata && !hasPreferences) return;

    const { data, error } = await client.rpc('upsert_long_term_profile_facts', {
      p_corp_id: corpId,
      p_user_id: userId,
      p_bot_user_id: botUserId,
      p_profile_facts: profileFactsJson,
      p_message_metadata: metadata ?? null,
      p_preference_facts: hasPreferences ? jobIntentFacts : null,
    });

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

    await this.invalidateCache(corpId, userId, botUserId);
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
    return (await this.getEpisodicState(corpId, userId, botUserId)).sessionSummaries;
  }

  async getConsolidationWatermarks(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<ConsolidationWatermarks> {
    return (await this.getEpisodicState(corpId, userId, botUserId)).consolidationWatermarks;
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

  async upsertMessageMetadata(
    corpId: string,
    userId: string,
    botUserId: string,
    metadata: MessageMetadata,
  ): Promise<void> {
    const cleanMetadata = this.normalizeMessageMetadata(metadata);
    if (!cleanMetadata) return;

    await this.upsertRow(corpId, userId, botUserId, { message_metadata: cleanMetadata });
  }

  // ==================== active_booking 操作 ====================

  /**
   * 读取候选人当前有效/待处理预约工单列表（按 linked_at 倒序，[0] 即最近一笔）。
   *
   * 单数关系由 `bookings[0] ?? null` 派生；需要“最近一笔”的调用方直接取 `[0]`。
   */
  async getActiveBookings(corpId: string, userId: string): Promise<ActiveBookingEntry[]> {
    const row = await this.getActiveBookingRow(corpId, userId);
    return normalizeActiveBookings(row?.active_booking ?? null);
  }

  /** 写入候选人当前有效/待处理预约工单指针（同候选人可保留多岗位工单）。 */
  async setActiveBooking(
    corpId: string,
    userId: string,
    workOrderId: number,
    metadata?: Pick<ActiveBookingEntry, 'job_id'>,
  ): Promise<void> {
    const existing = await this.getActiveBookings(corpId, userId);
    const activeBooking: ActiveBookingEntry = {
      work_order_id: workOrderId,
      linked_at: new Date().toISOString(),
      job_id: metadata?.job_id ?? null,
    };
    const bookings = [
      activeBooking,
      ...existing.filter((booking) => booking.work_order_id !== workOrderId),
    ].slice(0, 10);
    await this.upsertActiveBookingRow(corpId, userId, {
      active_booking: buildActiveBookingState(bookings),
    });
  }

  /**
   * 清空当前有效预约工单指针。
   *
   * expectedWorkOrderId 存在时只清匹配的当前工单，避免并发新预约刚写入后被旧取消回调误清。
   */
  async clearActiveBooking(
    corpId: string,
    userId: string,
    expectedWorkOrderId?: number,
  ): Promise<void> {
    if (expectedWorkOrderId != null) {
      const bookings = await this.getActiveBookings(corpId, userId);
      const remaining = bookings.filter((booking) => booking.work_order_id !== expectedWorkOrderId);
      if (remaining.length === bookings.length) return;
      await this.upsertActiveBookingRow(corpId, userId, {
        active_booking: buildActiveBookingState(remaining),
      });
      return;
    }

    await this.upsertActiveBookingRow(corpId, userId, { active_booking: null });
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

  /**
   * episodic 读边界懒迁移：旧 recent/archive 合成裸 SummaryEntry[]，摘要内旧水位搬到独立列。
   * 回写走 CAS RPC，避免较早的读快照覆盖并发 append/mark 已推进的摘要或水位。
   */
  private async getEpisodicState(
    corpId: string,
    userId: string,
    botUserId: string,
  ): Promise<NormalizedEpisodicState> {
    const row = await this.getRow(corpId, userId, botUserId);
    if (!row) {
      return {
        sessionSummaries: null,
        consolidationWatermarks: { ...EMPTY_CONSOLIDATION_WATERMARKS, bySession: {} },
        needsMigration: false,
      };
    }

    const normalized = normalizeEpisodicState(row);
    if (normalized.needsMigration && normalized.sessionSummaries) {
      return this.migrateEpisodicStateAtomic(corpId, userId, botUserId, row, normalized);
    }
    return normalized;
  }

  /**
   * compare-and-swap 懒迁移。RPC 未命中说明并发写已改变两列，此时以 RPC 返回的
   * 数据库当前值重新规范化；最多再尝试一次仍为旧形状的极窄竞争窗口。
   */
  private async migrateEpisodicStateAtomic(
    corpId: string,
    userId: string,
    botUserId: string,
    initialRow: AgentLongTermMemoryRow,
    initialNormalized: NormalizedEpisodicState,
  ): Promise<NormalizedEpisodicState> {
    const client = this.supabase.getSupabaseClient();
    if (!client) {
      this.logger.warn('Supabase 不可用，episodic 旧形状未持久化');
      return initialNormalized;
    }

    let expectedRow = initialRow;
    let normalized = initialNormalized;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const { data, error } = await client.rpc('migrate_long_term_episodic_state_atomic', {
        p_corp_id: corpId,
        p_user_id: userId,
        p_bot_user_id: botUserId,
        p_expected_session_summaries: expectedRow.episodic_session_summaries ?? null,
        p_expected_consolidation_watermarks: expectedRow.consolidation_watermarks ?? null,
        p_session_summaries: normalized.sessionSummaries,
        p_consolidation_watermarks: normalized.consolidationWatermarks,
      });

      if (error) {
        this.logger.warn('[migrateEpisodicStateAtomic] RPC 失败', error.message);
        throw error;
      }
      if (!data) return normalized;

      const currentRow = data as AgentLongTermMemoryRow;
      normalized = normalizeEpisodicState(currentRow);
      await this.invalidateCache(corpId, userId, botUserId);
      if (!normalized.needsMigration || !normalized.sessionSummaries) return normalized;
      expectedRow = currentRow;
    }

    return normalized;
  }

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
  ): Promise<AgentLongTermMemoryRow | null> {
    const cacheKey = `active-booking:${corpId}:${userId}`;
    const cached = await this.redis.get<AgentLongTermMemoryRow>(cacheKey);
    if (cached) return cached;

    const client = this.supabase.getSupabaseClient();
    if (!client) return null;
    const { data, error } = await client
      .from(TABLE)
      .select('*')
      .eq('corp_id', corpId)
      .eq('user_id', userId)
      .is('bot_user_id', null)
      .maybeSingle();
    if (error) {
      this.logger.warn('查询 active_booking 兼容行失败', error.message);
      return null;
    }
    if (!data) return null;

    const row = data as AgentLongTermMemoryRow;
    await this.redis
      .setex(cacheKey, this.config.longTermCacheTtl, row)
      .catch((error_) => this.logger.warn('active_booking 缓存回填失败', error_));
    return row;
  }

  private async upsertActiveBookingRow(
    corpId: string,
    userId: string,
    fields: Record<string, unknown>,
  ): Promise<void> {
    const client = this.supabase.getSupabaseClient();
    if (!client) return;

    const existing = await this.getActiveBookingRow(corpId, userId);
    const payload = { ...fields, updated_at: new Date().toISOString() };
    let error: { code?: string; message: string } | null = null;

    if (existing) {
      ({ error } = await client.from(TABLE).update(payload).eq('id', existing.id));
    } else {
      ({ error } = await client.from(TABLE).insert({
        corp_id: corpId,
        user_id: userId,
        bot_user_id: null,
        ...payload,
      }));
      if (error?.code === '23505') {
        ({ error } = await client
          .from(TABLE)
          .update(payload)
          .eq('corp_id', corpId)
          .eq('user_id', userId)
          .is('bot_user_id', null));
      }
    }

    if (error) this.logger.warn('upsert active_booking 失败', error.message);
    await this.redis.del(`active-booking:${corpId}:${userId}`).catch(() => {});
  }

  private normalizeMessageMetadata(metadata: MessageMetadata): MessageMetadata | null {
    const clean: MessageMetadata = {};
    for (const [key, value] of Object.entries(metadata) as Array<
      [keyof MessageMetadata, MessageMetadata[keyof MessageMetadata]]
    >) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'string' && value.trim().length === 0) continue;
      (clean as Record<string, unknown>)[key] = value;
    }
    return Object.keys(clean).length > 0 ? clean : null;
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
