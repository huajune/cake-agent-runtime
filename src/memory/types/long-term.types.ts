/** 用户身份信息 — 长期记忆 Profile，跨会话复用 */
export interface UserProfile {
  name: string | null;
  phone: string | null;
  gender: string | null;
  age: string | null;
  is_student: boolean | null;
  education: string | null;
  has_health_certificate: string | null;
}

export const USER_PROFILE_FIELD_KEYS = [
  'name',
  'phone',
  'gender',
  'age',
  'is_student',
  'education',
  'has_health_certificate',
] as const satisfies readonly (keyof UserProfile)[];

export type UserProfileFieldKey = (typeof USER_PROFILE_FIELD_KEYS)[number];
export type UserProfileFieldValue<K extends UserProfileFieldKey> = NonNullable<UserProfile[K]>;

export type ProfileFactConfidence = 'high' | 'medium' | 'low' | 'unknown';
export type ProfileFactSource =
  | 'candidate'
  | 'llm'
  | 'rule'
  | 'system'
  | 'memory'
  | 'derived'
  | 'booking'
  | 'extraction'
  | 'enrichment';

/** 长期 profile_facts 置信度语义。工具消费默认只 unwrap high。 */
export const PROFILE_FACT_CONFIDENCE_DESCRIPTIONS: Record<ProfileFactConfidence, string> = {
  high: '可跨会话自动采用。通常来自报名成功、候选人明确提交且经过业务校验的字段。',
  medium: '可给模型参考。通常来自会话沉淀、LLM 提取或外部补全，使用前需结合上下文。',
  low: '弱参考。仅用于提示模型可能存在该信息，不应进入程序化硬判断。',
  unknown: '旧数据或缺少元数据的兼容值。只能作为背景信息，工具默认不消费。',
};

/** 长期 profile_facts 来源语义。source 说明写入路径，不等同于置信度。 */
export const PROFILE_FACT_SOURCE_DESCRIPTIONS: Record<ProfileFactSource, string> = {
  candidate: '候选人直接明示的结构化输入，且写入链路保留了候选人来源。',
  llm: 'LLM 根据对话做的结构化提取。',
  rule: '确定性规则、正则、白名单或别名表匹配得到。',
  system: '外部系统或平台接口补充得到。',
  memory: '历史记忆或旧结构兼容迁移得到。',
  derived: '由其他字段推导得到。',
  booking: '预约/报名成功后写入，是当前最高质量的长期画像来源。',
  extraction: '会话沉淀时从 sessionFacts 抽取后写入；原 sessionFact 来源应记录在 evidence 中。',
  enrichment: '外部画像补全链路写入，例如客户详情接口补充性别。',
};

/** 长期画像字段事实：字段自身携带值、置信度、来源和证据。 */
export interface UserProfileFactValue<T> {
  value: T;
  confidence: ProfileFactConfidence;
  source: ProfileFactSource;
  evidence: string;
  /** ISO timestamp，字段最后一次被写入长期记忆的时间 */
  updatedAt: string;
  /**
   * 数据血缘：沉淀写入该事实的会话（sessionId=chatId，bot 维度）。
   * 双 bot 服务同一候选人时用于追溯"这条事实来自哪次会话"，并支撑跨会话口径。
   * 存量字段缺失时为 undefined（向后兼容）。
   */
  originSessionId?: string;
  /** 数据血缘：沉淀写入该事实的托管账号 wxid（imBotId）。可离线映射回招募经理。 */
  originBotId?: string;
}

export type UserProfileFactMaybeValue<T> = UserProfileFactValue<T> | null;

/** 长期画像事实视图，和 sessionFacts/highConfidenceFacts 保持同一种字段包裹结构。 */
export type UserProfileFacts = {
  [K in UserProfileFieldKey]: UserProfileFactMaybeValue<UserProfileFieldValue<K>>;
};

const PROFILE_CONFIDENCE_RANK: Record<ProfileFactConfidence, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

export function isUserProfileFieldKey(value: string): value is UserProfileFieldKey {
  return (USER_PROFILE_FIELD_KEYS as readonly string[]).includes(value);
}

export function isUserProfileFactValue<T = unknown>(
  value: unknown,
): value is UserProfileFactValue<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'source' in value &&
    'evidence' in value
  );
}

export function userProfileFactValue<T>(
  value: T,
  meta: {
    confidence: ProfileFactConfidence;
    source: ProfileFactSource;
    evidence: string;
    updatedAt?: string;
    originSessionId?: string;
    originBotId?: string;
  },
): UserProfileFactValue<T> {
  return {
    value,
    confidence: meta.confidence,
    source: meta.source,
    evidence: meta.evidence,
    updatedAt: meta.updatedAt ?? new Date().toISOString(),
    ...(meta.originSessionId ? { originSessionId: meta.originSessionId } : {}),
    ...(meta.originBotId ? { originBotId: meta.originBotId } : {}),
  };
}

export function unwrapUserProfileFactValue<T>(
  value: UserProfileFactValue<T> | T | null | undefined,
  options: { minConfidence?: ProfileFactConfidence } = {},
): T | null {
  if (value === null || value === undefined) return null;
  if (!isUserProfileFactValue<T>(value)) return value;
  const minConfidence = options.minConfidence;
  if (
    minConfidence &&
    PROFILE_CONFIDENCE_RANK[value.confidence] < PROFILE_CONFIDENCE_RANK[minConfidence]
  ) {
    return null;
  }
  return value.value;
}

export function createEmptyUserProfileFacts(): UserProfileFacts {
  return {
    name: null,
    phone: null,
    gender: null,
    age: null,
    is_student: null,
    education: null,
    has_health_certificate: null,
  };
}

export function unwrapUserProfileFacts(
  facts: UserProfileFacts | UserProfile | null | undefined,
  options: { minConfidence?: ProfileFactConfidence } = {},
): UserProfile | null {
  if (!facts) return null;

  const profile: UserProfile = {
    name: null,
    phone: null,
    gender: null,
    age: null,
    is_student: null,
    education: null,
    has_health_certificate: null,
  };
  let hasValue = false;

  for (const key of USER_PROFILE_FIELD_KEYS) {
    const value = unwrapUserProfileFactValue(facts[key], options);
    if (value !== null && value !== undefined) {
      (profile as Record<UserProfileFieldKey, string | boolean | null>)[key] = value;
      hasValue = true;
    }
  }

  return hasValue ? profile : null;
}

export function toUserProfileFacts(
  profile: Partial<UserProfile>,
  meta: {
    confidence: ProfileFactConfidence;
    source: ProfileFactSource;
    evidence: string;
    updatedAt?: string;
  },
): UserProfileFacts {
  const facts = createEmptyUserProfileFacts();
  for (const key of USER_PROFILE_FIELD_KEYS) {
    const value = profile[key];
    if (value !== null && value !== undefined) {
      (facts as Record<UserProfileFieldKey, UserProfileFactValue<string | boolean> | null>)[key] =
        userProfileFactValue(value, meta);
    }
  }
  return facts;
}

/** 消息回调元数据 — 冗余到长期记忆中 */
export interface MessageMetadata {
  botId?: string;
  imBotId?: string;
  imContactId?: string;
  contactType?: number;
  contactName?: string;
  externalUserId?: string;
  avatar?: string;
}

/** 单条对话摘要 */
export interface SummaryEntry {
  summary: string;
  sessionId: string;
  startTime: string;
  endTime: string;
}

/** 对话摘要数据 — 分层压缩结构 */
export interface SummaryData {
  /** 最近 N 条详细摘要 */
  recent: SummaryEntry[];
  /** 更早的摘要被 LLM 压缩合并成的总结 */
  archive: string | null;
  /**
   * 最近一次已沉淀到长期记忆的消息边界（用户维度，跨 bot 共享）。
   * 历史字段：双 bot 服务同一候选人时会互相推进，仅作为 lastSettledBySession
   * 缺失时的回退基准。
   */
  lastSettledMessageAt: string | null;
  /**
   * 按会话（sessionId=chatId，bot 维度）隔离的沉淀边界。
   * 修复双 bot 场景：bot A 推进用户级边界后，bot B 边界之前的消息永不沉淀。
   */
  lastSettledBySession?: Record<string, string> | null;
}

/** agent_long_term_memories 行中的回调元信息。 */
export interface LongTermMemoryMetadata {
  createdAt: string;
  updatedAt: string;
  messageMetadata: MessageMetadata | null;
}

/** 长期记忆层在业务上的完整状态视图。 */
export interface LongTermMemoryState {
  profile: UserProfileFacts | null;
  summary: SummaryData | null;
  metadata: LongTermMemoryMetadata | null;
}

/** agent_long_term_memories 表行类型（每用户一行，Profile facts + Summary jsonb）。 */
/**
 * 候选人当前有效/待处理预约工单指针。
 *
 * 对应 agent_long_term_memories.active_booking 列（迁移 20260630120000 由 latest_booking 改名，
 * JSONB 键 latest_work_order_id 同步改为 work_order_id）。
 * 业务状态每次实时查海绵（Redis 5min 缓存）。同一候选人可同时报名多个岗位，因此新数据会在
 * `bookings` 中保留多个工单；顶层字段仍指向最近一笔，兼容旧调用方。
 */
export interface ActiveBooking {
  work_order_id: number;
  linked_at: string;
  job_id?: number | null;
  interview_time?: string | null;
  brand_name?: string | null;
  store_name?: string | null;
  job_name?: string | null;
  bookings?: ActiveBooking[];
}

export interface AgentLongTermMemoryRow {
  id: string;
  corp_id: string;
  user_id: string;
  profile_facts?: UserProfileFacts | null;
  preference_facts?: LongTermPreferenceFacts | null;
  summary_data?: SummaryData | null;
  message_metadata?: MessageMetadata | null;
  active_booking?: ActiveBooking | null;
  created_at: string;
  updated_at: string;
}

/** 长期记忆层的真实持久化结果。 */
export interface LongTermStorageResult {
  source: 'supabase';
  table: 'agent_long_term_memories';
  row: AgentLongTermMemoryRow | null;
}

// ==================== 长期求职意向（preference_facts） ====================

/**
 * 跨会话沉淀的求职意向字段。
 *
 * 只收跨会话稳定的意向：城市/区域/地点/品牌/岗位/班次/薪资/用工形式/排班硬约束，
 * 以及带日期锚的推迟意向与最早可面日期。
 * short_term / time_windows / open_position 是单次求职 episode 的临时态，不沉淀。
 */
export const LONG_TERM_PREFERENCE_FIELD_KEYS = [
  'city',
  'district',
  'location',
  'brands',
  'position',
  'schedule',
  'salary',
  'labor_form',
  'schedule_constraint',
  'delayed_intent',
  'available_after',
] as const;

export type LongTermPreferenceFieldKey = (typeof LONG_TERM_PREFERENCE_FIELD_KEYS)[number];

/**
 * 长期求职意向集合。
 *
 * 覆盖语义是**快照式整组覆盖**（最新一段会话的意向赢），与 session facts 的
 * deepMerge 累积不同——累积语义会让错值/错字变体永远清不掉（张漪 case 的
 * pref.location 教训）。settlement 是唯一写方。
 */
export type LongTermPreferenceFacts = Partial<
  Record<LongTermPreferenceFieldKey, UserProfileFactValue<unknown>>
>;

/** 便于复用的长期记忆 upsert payload。 */
export type ProfileUpsertPayload = Partial<UserProfile>;

/** 最大保留的详细摘要条数 */
export const MAX_RECENT_SUMMARIES = 5;
