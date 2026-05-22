import { z } from 'zod';
import type { MemoryEntry } from '../stores/store.types';

// ==================== 1. 提取 schema（LLM 输出结构） ====================

/** 面试信息 schema */
export const InterviewInfoSchema = z.object({
  name: z.string().nullable().describe('姓名'),
  phone: z.string().nullable().describe('联系方式'),
  gender: z.string().nullable().describe('性别'),
  gender_source: z
    .enum(['candidate', 'system'])
    .nullable()
    .optional()
    .describe('性别来源：candidate=候选人自陈，system=企微系统兜底标签'),
  age: z.string().nullable().describe('年龄'),
  applied_store: z.string().nullable().describe('应聘门店'),
  applied_position: z.string().nullable().describe('应聘岗位'),
  interview_time: z.string().nullable().describe('面试时间'),
  is_student: z.boolean().nullable().describe('是否学生'),
  education: z.string().nullable().describe('学历'),
  has_health_certificate: z.string().nullable().describe('健康证'),
});

/**
 * 城市事实（带置信度与证据来源）
 *
 * - evidence 表示城市是如何推导出来的
 * - confidence 目前规则抽取均为 'high'；保留 'low' 给未来扩展
 * - 这里有意只保留当前规则抽取会直接产出的 evidence；
 *   历史上的 conflict / memory_carry_over 属于旧链路或跨轮合成结果，不再由当前 extractor 输出
 */
export const CityFactEvidenceSchema = z.enum([
  'municipality_compact',
  'explicit_city',
  'unique_district_alias',
  'hotspot_alias',
]);

export const CityFactSchema = z.object({
  value: z.string(),
  confidence: z.enum(['high', 'low']),
  evidence: CityFactEvidenceSchema,
});

export type CityFact = z.infer<typeof CityFactSchema>;
export type CityFactEvidence = z.infer<typeof CityFactEvidenceSchema>;

/**
 * 兼容旧数据的 city 字段解析：
 * - 字符串（旧 Redis 数据、LLM 原始输出）→ 归一化为 `{ value, confidence: 'high', evidence: 'explicit_city' }`
 * - 对象 → 直接校验为 CityFact
 * - null/空串 → null
 */
const NullableCityFactSchema = z
  .union([CityFactSchema, z.string(), z.null()])
  .transform((value): CityFact | null => {
    if (value === null) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/市$/, '');
      return trimmed ? { value: trimmed, confidence: 'high', evidence: 'explicit_city' } : null;
    }
    return value;
  });

/**
 * 推迟意向：候选人明确表达"延期/再说/不急/晚点"时记录的事实。
 *
 * badcase 簇 delayed_intent（3azxa3pf 五一后才面 / 1sy7d9ia 下周再说 / kjc5877z 周六日面试 等）：
 * Agent 看到推迟信号仍反复催促 booking，导致候选人拉黑。
 * 沉淀到此字段后，hard-constraints / booking gate 应禁止本轮及后续主动催面。
 */
export const DelayedIntentSchema = z.object({
  /** 推迟到何时（保留原话，如 "五一后" / "下周" / "晚点联系"） */
  until: z.string(),
  /** 触发该判断的原话片段，用于审计与去歧义 */
  raw: z.string(),
});
export type DelayedIntent = z.infer<typeof DelayedIntentSchema>;

const NullableDelayedIntentSchema = DelayedIntentSchema.nullable().default(null);

/**
 * 候选人班次硬约束（结构化版本，与 duliday_job_list 工具的 candidateScheduleConstraint 入参对齐）。
 *
 * 历史 badcase 簇 schedule_constraint_forgotten：候选人在 T1 说"做一休一/每周最多两天/
 * 只周末/只晚班"等班次硬约束，Agent 在 T5+ 调 duliday_job_list 时忘了把约束带上，
 * 推出工作日强排班岗位，候选人到店发现不符。
 *
 * 设计：把 schedule（自由文本）持久化的同时，额外存一份结构化对象，让下游 tool
 * 调用可以直接读取并自动带上 candidateScheduleConstraint 入参，不靠 LLM 记忆。
 */
export const ScheduleConstraintFactSchema = z.object({
  onlyWeekends: z.boolean().nullable().default(null).describe('只周末上班'),
  onlyEvenings: z.boolean().nullable().default(null).describe('只做晚班/夜班'),
  onlyMornings: z.boolean().nullable().default(null).describe('只做早班'),
  maxDaysPerWeek: z
    .number()
    .int()
    .min(1)
    .max(7)
    .nullable()
    .default(null)
    .describe('每周最多上班 N 天（"做一休一"→1，"做二休一"→2，"每周最多两天"→2）'),
});
export type ScheduleConstraintFact = z.infer<typeof ScheduleConstraintFactSchema>;

const NullableScheduleConstraintSchema = ScheduleConstraintFactSchema.nullable().default(null);

/**
 * 候选人明确给出的"未来 X 日期之后才能面试"硬约束。
 *
 * 历史 badcase 簇 future_date_constraint：候选人说"五一回来再说/五月 1 日之后/
 * 5 月 15 日"等明确日期，Agent 继续催"今天/明天能不能面"。
 *
 * 设计：仅持久化能解析成明确日期（YYYY-MM-DD）的信号；
 * 模糊词（"等开学" / "月底" / "下周后"）不入库，让 Agent 调 request_handoff 转人工。
 */
export const AvailableAfterFactSchema = z.object({
  /** YYYY-MM-DD 格式的最早可面试日期；早于该日期的 slot 均视为不可约 */
  date: z.string().describe('YYYY-MM-DD'),
  /** 触发该判断的候选人原话片段，用于审计 */
  raw: z.string(),
});
export type AvailableAfterFact = z.infer<typeof AvailableAfterFactSchema>;

const NullableAvailableAfterSchema = AvailableAfterFactSchema.nullable().default(null);

/**
 * 意向偏好 schema — 存储态（Redis/记忆）
 *
 * city 字段为 CityFact 对象（含 confidence/evidence），
 * 但解析时接受旧的字符串数据做自动归一化，保证 Redis 兼容。
 *
 * 新增字段（与 booking gate / hard-constraints 配套）：
 * - delayed_intent：候选人明确推迟/再说意向
 * - short_term：候选人只能做几天/临时（与 minMonths 岗位互斥）
 * - open_position：候选人"什么岗位都行/X都可以"宽口径（不锁定到 position）
 * - time_windows：候选人给出的可用时间窗口（如"17点后"、"14点前"）
 *
 * 兼容性：所有新字段均 nullable + default(null)，旧 Redis 数据缺字段时解析为 null。
 */
export const PreferencesSchema = z.object({
  brands: z.array(z.string()).nullable().describe('意向品牌'),
  salary: z.string().nullable().describe('意向薪资'),
  position: z.array(z.string()).nullable().describe('意向岗位'),
  schedule: z.string().nullable().describe('意向班次'),
  city: NullableCityFactSchema.describe(
    '意向城市（对象：{ value, confidence, evidence }；兼容旧字符串输入，将自动归一化）',
  ),
  district: z.array(z.string()).nullable().describe('意向区域'),
  location: z.array(z.string()).nullable().describe('意向地点/商圈'),
  labor_form: z.string().nullable().describe('用工形式'),
  delayed_intent: NullableDelayedIntentSchema.describe(
    '推迟意向：候选人明确表达"推迟/再说/不急/晚点"时记录，下游禁止本轮及后续主动催面',
  ),
  short_term: z.boolean().nullable().default(null).describe('是否短期工（"做几天/临时"等）'),
  open_position: z
    .boolean()
    .nullable()
    .default(null)
    .describe('是否岗位开放（"什么都可以/X都可以"句式，position 应留空避免被锁定）'),
  time_windows: z
    .array(z.string())
    .nullable()
    .default(null)
    .describe('可用时间窗口（保留原话，如"17点后"、"14点前"）'),
  schedule_constraint: NullableScheduleConstraintSchema.describe(
    '班次硬约束（结构化）：onlyWeekends/onlyEvenings/onlyMornings/maxDaysPerWeek，与 duliday_job_list 入参对齐',
  ),
  available_after: NullableAvailableAfterSchema.describe(
    '未来日期硬约束：仅当候选人原话明确给出可解析的具体日期时填写；早于此日期的 slot 视为不可约',
  ),
});

/**
 * LLM 结构化输出的 Preferences schema。
 *
 * 与 PreferencesSchema 的唯一区别：city 用简单 `string | null`，
 * 避免 Zod union/transform 在生成 JSON schema 时产生 oneOf 让 LLM 误解结构。
 * LLM 返回后，service 层再通过 EntityExtractionResultSchema.parse 归一化为 CityFact。
 */
export const LLMPreferencesSchema = z.object({
  brands: z.array(z.string()).nullable().describe('意向品牌'),
  salary: z.string().nullable().describe('意向薪资'),
  position: z.array(z.string()).nullable().describe('意向岗位'),
  schedule: z.string().nullable().describe('意向班次'),
  city: z.string().nullable().describe('意向城市（输出为字符串，不带"市"后缀）'),
  district: z.array(z.string()).nullable().describe('意向区域'),
  location: z.array(z.string()).nullable().describe('意向地点/商圈'),
  labor_form: z.string().nullable().describe('用工形式'),
  delayed_intent: DelayedIntentSchema.nullable().describe(
    '推迟意向（仅在候选人原话明确出现"推迟/再说/不急/晚点/X后/下周/周末后"等延期信号时填写；含糊不要填）',
  ),
  short_term: z
    .boolean()
    .nullable()
    .describe('是否短期工（仅在原话出现"做几天/几天/临时/短期"等明确短期信号时填 true）'),
  open_position: z
    .boolean()
    .nullable()
    .describe(
      '是否岗位开放（候选人说"什么都可以/X都行/什么工作都行/什么都能做"等宽口径句式时填 true；此时 position 必须留空）',
    ),
  time_windows: z
    .array(z.string())
    .nullable()
    .describe('可用时间窗口（候选人给出的时间点/段，如"17点后"、"14点前"）'),
  schedule_constraint: ScheduleConstraintFactSchema.nullable().describe(
    '班次硬约束结构化：候选人原话出现"做一休一/每周最多 N 天/只周末/只晚班"等明确硬约束时填写；含糊不填',
  ),
  available_after: AvailableAfterFactSchema.nullable().describe(
    '未来日期硬约束：候选人原话给出可解析的明确日期（"5月1日之后/2026-05-15 之后"）时填写 YYYY-MM-DD；模糊词（"等开学/月底"）一律不填',
  ),
});

/** 实体提取结果 schema — 存储态（包含 CityFact） */
export const EntityExtractionResultSchema = z.object({
  interview_info: InterviewInfoSchema,
  preferences: PreferencesSchema,
  reasoning: z
    .string()
    .describe('提取与推理说明：列出每个字段的来源（直接提取/推理得出），推理字段需说明推理链'),
});

/** LLM 结构化输出 schema — city 字段为字符串 */
export const LLMEntityExtractionResultSchema = z.object({
  interview_info: InterviewInfoSchema,
  preferences: LLMPreferencesSchema,
  reasoning: z
    .string()
    .describe('提取与推理说明：列出每个字段的来源（直接提取/推理得出），推理字段需说明推理链'),
});

/** 实体提取结果类型 */
export type EntityExtractionResult = z.infer<typeof EntityExtractionResultSchema>;
export type InterviewInfo = z.infer<typeof InterviewInfoSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

/** 实体提取失败时的降级结果。 */
export const FALLBACK_EXTRACTION: EntityExtractionResult = {
  interview_info: {
    name: null,
    phone: null,
    gender: null,
    gender_source: null,
    age: null,
    applied_store: null,
    applied_position: null,
    interview_time: null,
    is_student: null,
    education: null,
    has_health_certificate: null,
  },
  preferences: {
    brands: null,
    salary: null,
    position: null,
    schedule: null,
    city: null,
    district: null,
    location: null,
    labor_form: null,
    delayed_intent: null,
    short_term: null,
    open_position: null,
    time_windows: null,
    schedule_constraint: null,
    available_after: null,
  },
  reasoning: '实体提取失败，使用空值降级',
};

// ==================== 2. 业务状态（当前会话的结构化短期记忆） ====================

/** 候选岗位池摘要 — 复用 jobId 和补充查询 */
export interface RecommendedJobSummary {
  jobId: number;
  brandName: string | null;
  jobName: string | null;
  storeName: string | null;
  storeAddress?: string | null;
  cityName: string | null;
  regionName: string | null;
  laborForm: string | null;
  salaryDesc: string | null;
  /** 班次摘要（由 composeShiftTimeText 生成）。null 表示工具调用时未获取到班次数据。 */
  shiftSummary?: string | null;
  jobCategoryName: string | null;
  ageRequirement?: string | null;
  educationRequirement?: string | null;
  healthCertificateRequirement?: string | null;
  studentRequirement?: string | null;
  distanceKm?: number | null;
}

export const RecommendedJobSummarySchema = z.object({
  jobId: z.number().int(),
  brandName: z.string().nullable(),
  jobName: z.string().nullable(),
  storeName: z.string().nullable(),
  storeAddress: z.string().nullable().optional(),
  cityName: z.string().nullable(),
  regionName: z.string().nullable(),
  laborForm: z.string().nullable(),
  salaryDesc: z.string().nullable(),
  shiftSummary: z.string().nullable().optional(),
  jobCategoryName: z.string().nullable(),
  ageRequirement: z.string().nullable().optional(),
  educationRequirement: z.string().nullable().optional(),
  healthCertificateRequirement: z.string().nullable().optional(),
  studentRequirement: z.string().nullable().optional(),
  distanceKm: z.number().nullable().optional(),
});

/** 已邀入的群记录 */
export interface InvitedGroupRecord {
  /** 群名称 */
  groupName: string;
  /** 城市 */
  city: string;
  /** 行业 */
  industry?: string;
  /** 邀请时间 */
  invitedAt: string;
}

/** 会话事实层 — 当前这次求职会话的结构化状态 */
export interface WeworkSessionState {
  facts: EntityExtractionResult | null;
  /** 每轮覆盖：最后一次 duliday_job_list 调用返回的候选岗位池 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 候选人当前明确在聊或准备报名的岗位 */
  currentFocusJob: RecommendedJobSummary | null;
  /** 本会话中已邀入的兼职群 */
  invitedGroups: InvitedGroupRecord[] | null;
}

export const InvitedGroupRecordSchema = z.object({
  groupName: z.string(),
  city: z.string(),
  industry: z.string().optional(),
  invitedAt: z.string(),
});

export const WeworkSessionStateSchema = z.object({
  facts: EntityExtractionResultSchema.nullable(),
  lastCandidatePool: z.array(RecommendedJobSummarySchema).nullable(),
  presentedJobs: z.array(RecommendedJobSummarySchema).nullable(),
  currentFocusJob: RecommendedJobSummarySchema.nullable(),
  invitedGroups: z.array(InvitedGroupRecordSchema).nullable(),
});

/** 当前会话没有任何结构化记忆时的空状态。 */
export const EMPTY_SESSION_STATE: WeworkSessionState = {
  facts: null,
  lastCandidatePool: null,
  presentedJobs: null,
  currentFocusJob: null,
  invitedGroups: null,
};

// ==================== 3. Redis 持久化结构 ====================

/** Redis 中 session-facts 层实际写入的 content 结构。 */
export type SessionFactsRedisContent = Partial<WeworkSessionState>;

export const SessionFactsRedisContentSchema = WeworkSessionStateSchema.partial();

/** Redis 中 session-facts 层实际存储的 entry 结构。 */
export type SessionFactsRedisEntry = MemoryEntry<SessionFactsRedisContent>;

/** 结构化短期记忆层的真实持久化结果。 */
export interface SessionFactsStorageResult {
  source: 'redis';
  keyPattern: 'facts:{corpId}:{userId}:{sessionId}';
  entry: SessionFactsRedisEntry | null;
}
