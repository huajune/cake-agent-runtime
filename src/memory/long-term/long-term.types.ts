import { z } from 'zod';
import {
  CANDIDATE_FACT_PRODUCERS,
  type CandidateFactProducer,
} from '@resolution/evidence/claim.types';
import {
  FACT_CONFIDENCE_LEVELS_DESC,
  FACT_CONFIDENCE_RANK,
  type FactConfidence,
} from '../types/confidence-rank';
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

export type ProfileFactConfidence = FactConfidence;

/** 长期 profile_facts 置信度语义。工具消费默认只 unwrap high。 */
export const PROFILE_FACT_CONFIDENCE_DESCRIPTIONS: Record<ProfileFactConfidence, string> = {
  high: '可跨会话自动采用。仅来自收资表单办结后的报名事实。',
  medium: '表单外软事实或兼容存量，使用前需结合当前账号与上下文。',
};

/** 长期 profile_facts 来源语义。source 说明事实出身，不等同于置信度或运输路径。 */
export const PROFILE_FACT_SOURCE_DESCRIPTIONS: Record<CandidateFactProducer, string> = {
  candidate_quote: '候选人直接明示且经原话复算或答问绑定确认。',
  rule: '确定性规则、正则、白名单或别名表匹配得到。',
  model: 'LLM 根据对话做的结构化提取或模型工具入参。',
  system: '外部系统或平台接口补充得到。',
  manual: '真人经理带外裁决。',
  archive: '历史记忆或跨会话档案回放得到。',
};

/** 长期画像字段事实：字段自身携带值、置信度、来源和证据。 */
export interface UserProfileFactValue<T> {
  value: T;
  confidence: ProfileFactConfidence;
  source: CandidateFactProducer;
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

const LEGACY_PROFILE_FACT_PRODUCERS: Readonly<Record<string, CandidateFactProducer>> = {
  candidate: 'candidate_quote',
  llm: 'model',
  rule: 'rule',
  system: 'system',
  memory: 'archive',
  derived: 'rule',
  tool: 'system',
  booking: 'system',
  extraction: 'archive',
  enrichment: 'system',
};

const StoredProfileFactProducerSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (LEGACY_PROFILE_FACT_PRODUCERS[value] ?? value) : value),
  z.enum(CANDIDATE_FACT_PRODUCERS),
);

/** 长期档案读边界 schema：兼容旧 source，输出只含六章根词汇。 */
export const UserProfileFactValueSchema = z.object({
  value: z.unknown(),
  confidence: z.preprocess(
    (value) => (value === 'low' || value === 'unknown' ? 'medium' : value),
    z.enum(FACT_CONFIDENCE_LEVELS_DESC),
  ),
  source: StoredProfileFactProducerSchema,
  evidence: z.string(),
  updatedAt: z.string(),
  originSessionId: z.string().optional(),
  originBotId: z.string().optional(),
});

export type UserProfileFactMaybeValue<T> = UserProfileFactValue<T> | null;

/** 长期画像事实视图，和 sessionFacts/ruleFacts 保持同一种字段包裹结构。 */
export type UserProfileFacts = {
  [K in UserProfileFieldKey]: UserProfileFactMaybeValue<UserProfileFieldValue<K>>;
};

// 权威定义见 confidence-rank.ts（与会话层共用；DB RPC long_term_profile_confidence_rank 为其 SQL 镜像）。
const PROFILE_CONFIDENCE_RANK = FACT_CONFIDENCE_RANK;

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
    source: CandidateFactProducer;
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
    source: CandidateFactProducer;
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
  /** 摘要所属托管账号；召回时严格按账号过滤。 */
  originBotId?: string;
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
   * 双 bot 场景必须隔离：共用用户级边界时，bot A 推进后 bot B 边界之前的消息永不沉淀。
   */
  lastSettledBySession?: Record<string, string> | null;
}

/** agent_long_term_memories 表行类型（每用户一行，Profile facts + Summary jsonb）。 */
/**
 * 候选人当前有效/待处理预约工单指针。
 *
 * 沿革：迁移 20260630120000 将 agent_long_term_memories.latest_booking 改名为
 * active_booking，JSONB 键 latest_work_order_id 同步改为 work_order_id。
 * 本指针的前身 interview_booking_records 是以日期、品牌、门店为联合唯一维度的聚合
 * 计数表，逐人身份只是后补字段；它因缺少稳定逐人身份且 bot_im_id 会造成裂行，于
 * 20260625 删除。当时按性质一拆为二：统计漏斗归 ops_events('booking.succeeded')，
 * 候选人的当前工单关系归档案本列。住进档案是主动拆分的结果，不是无意寄居。
 *
 * 暂住本表的边界：
 * - 本结构仅保存 work_order_id / linked_at / job_id / bookings 事务指针；面试时间、门店等
 *   业务状态唯一权威是海绵，使用时必须实时查询，不在长期记忆复制事实。
 * - 访问模式是按 corpId + userId 跨会话读取，与每用户一行的长期记忆表同构。
 * - `bookings` 保留同一候选人的多岗位工单；代码侧单数 API 从该列表派生最近一笔。
 *   写入侧的顶层镜像仅用于兼容老行 JSONB 形态，不代表第二份业务状态。
 *
 * 迁居触发条件：出现“按工单反查候选人”需求，或工单状态回流（webhook）立项时，
 * 必须迁入 biz 独立关系指针表，按 corp_id + user_id + work_order_id 一行一工单，
 * 身份口径使用 wecomUserId；严禁复活旧聚合计数表形态。
 *
 * 硬纪律：本结构禁止新增业务字段；任何“顺手存一下面试时间/门店”的提案一律拒绝。
 *
 * 类型拆分（core-flow-review 议题 3-2，纯编译期标注、**JSONB 存储形态与运行时读写逻辑
 * 逐字节不变**）：此前单个 interface 同时承担"列表项"与"状态根"两种角色且允许无限自嵌
 * （`bookings?: ActiveBooking[]`），读代码时无法从类型分辨拿到的是条目还是整块状态。
 */

/** 列表项：一笔工单关系。JSONB 里 `bookings[]` 的元素形态。 */
export interface ActiveBookingEntry {
  work_order_id: number;
  linked_at: string;
  job_id?: number | null;
}

/**
 * 状态根：`active_booking` 列的整体形态。
 *
 * 顶层 entry 字段是**最近一笔的镜像**，仅为兼容老行 JSONB 形态而写；
 * `bookings` 才是全量列表。读侧一律经 normalizeActiveBookings 归并两者，
 * 不要直接依赖顶层镜像。
 */
export interface ActiveBookingState extends ActiveBookingEntry {
  bookings?: ActiveBookingEntry[];
}

export interface AgentLongTermMemoryRow {
  id: string;
  corp_id: string;
  user_id: string;
  profile_facts?: UserProfileFacts | null;
  preference_facts?: LongTermPreferenceFacts | null;
  summary_data?: SummaryData | null;
  message_metadata?: MessageMetadata | null;
  active_booking?: ActiveBookingState | null;
  created_at: string;
  updated_at: string;
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
 * pref.location 教训）。consolidation 是唯一写方。
 */
export type LongTermPreferenceFacts = Partial<
  Record<LongTermPreferenceFieldKey, UserProfileFactValue<unknown>>
>;

/** 便于复用的长期记忆 upsert payload。 */
export type ProfileUpsertPayload = Partial<UserProfile>;

/** 最大保留的详细摘要条数 */
export const MAX_RECENT_SUMMARIES = 5;
