import { z } from 'zod';
import type { MemoryEntry } from '../stores/store.types';

// ==================== 1. 提取 schema（LLM 输出结构） ====================

/** 面试信息 schema */
export const InterviewInfoSchema = z.object({
  name: z.string().nullable().describe('姓名'),
  phone: z.string().nullable().describe('联系方式'),
  gender: z.string().nullable().describe('性别'),
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
 * 意向偏好 schema — 存储态（Redis/记忆）
 *
 * city 字段为 CityFact 对象（含 confidence/evidence），
 * 但解析时接受旧的字符串数据做自动归一化，保证 Redis 兼容。
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
  /**
   * 当前这段会话最后一次仍在继续聊的时间。
   *
   * 用途：
   * - 判断这段会话是否已经闲置到可以沉淀
   * - 不等于记忆沉淀时间，也不等于某条摘要的边界时间
   */
  lastSessionActiveAt?: string;
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
  lastSessionActiveAt: z.string().optional(),
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
