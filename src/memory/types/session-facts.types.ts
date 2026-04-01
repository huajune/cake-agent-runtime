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

/** 意向偏好 schema */
export const PreferencesSchema = z.object({
  brands: z.array(z.string()).nullable().describe('意向品牌'),
  salary: z.string().nullable().describe('意向薪资'),
  position: z.array(z.string()).nullable().describe('意向岗位'),
  schedule: z.string().nullable().describe('意向班次'),
  city: z.string().nullable().describe('意向城市'),
  district: z.array(z.string()).nullable().describe('意向区域'),
  location: z.array(z.string()).nullable().describe('意向地点/商圈'),
  labor_form: z.string().nullable().describe('用工形式'),
});

/** 实体提取结果 schema — LLM generateObject 的输出结构 */
export const EntityExtractionResultSchema = z.object({
  interview_info: InterviewInfoSchema,
  preferences: PreferencesSchema,
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
  cityName: string | null;
  regionName: string | null;
  laborForm: string | null;
  salaryDesc: string | null;
  jobCategoryName: string | null;
  distanceKm?: number | null;
}

export const RecommendedJobSummarySchema = z.object({
  jobId: z.number().int(),
  brandName: z.string().nullable(),
  jobName: z.string().nullable(),
  storeName: z.string().nullable(),
  cityName: z.string().nullable(),
  regionName: z.string().nullable(),
  laborForm: z.string().nullable(),
  salaryDesc: z.string().nullable(),
  jobCategoryName: z.string().nullable(),
  distanceKm: z.number().nullable().optional(),
});

/** 会话事实层 — 当前这次求职会话的结构化状态 */
export interface WeworkSessionState {
  facts: EntityExtractionResult | null;
  /** 每轮覆盖：最后一次 duliday_job_list 调用返回的候选岗位池 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 候选人当前明确在聊或准备报名的岗位 */
  currentFocusJob: RecommendedJobSummary | null;
  /**
   * 当前这段会话最后一次仍在继续聊的时间。
   *
   * 用途：
   * - 判断这段会话是否已经闲置到可以沉淀
   * - 不等于记忆沉淀时间，也不等于某条摘要的边界时间
   */
  lastSessionActiveAt?: string;
}

export const WeworkSessionStateSchema = z.object({
  facts: EntityExtractionResultSchema.nullable(),
  lastCandidatePool: z.array(RecommendedJobSummarySchema).nullable(),
  presentedJobs: z.array(RecommendedJobSummarySchema).nullable(),
  currentFocusJob: RecommendedJobSummarySchema.nullable(),
  lastSessionActiveAt: z.string().optional(),
});

/** 当前会话没有任何结构化记忆时的空状态。 */
export const EMPTY_SESSION_STATE: WeworkSessionState = {
  facts: null,
  lastCandidatePool: null,
  presentedJobs: null,
  currentFocusJob: null,
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
