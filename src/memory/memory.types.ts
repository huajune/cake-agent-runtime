import { z } from 'zod';

// ========== 记忆分类 ==========

/**
 * 记忆类别 — 按语义分类，MemoryService 根据 key 前缀路由
 *
 * 对标 ZeroClaw MemoryCategory（Core/Daily/Conversation）
 * 适配招聘客服场景：stage（阶段）/ facts（会话事实）/ profile（用户画像）
 */
export enum MemoryCategory {
  /** 对话阶段状态（currentStage, advancedAt, reason） */
  STAGE = 'stage',
  /** 候选人会话事实（姓名/电话/偏好、已推荐岗位） */
  FACTS = 'facts',
  /** 用户画像（Supabase 持久化，本期仅基础设施） */
  PROFILE = 'profile',
}

// ========== TTL 常量 ==========

export const MEMORY_TTL = {
  /** 阶段状态 — 招聘流程可跨数天 */
  STAGE: 3 * 24 * 60 * 60, // 3d = 259200s
  /** 会话事实 — 跨请求累积 */
  FACTS: 3 * 24 * 60 * 60, // 3d
  /** Profile Redis 缓存 */
  PROFILE_CACHE: 2 * 60 * 60, // 2h = 7200s
} as const;

// ========== Key 前缀 ==========

export const MEMORY_KEY_PREFIX = {
  [MemoryCategory.STAGE]: 'stage:',
  [MemoryCategory.FACTS]: 'wework_session:',
  [MemoryCategory.PROFILE]: 'profile:',
} as const;

// ========== Store 接口 ==========

/** 通用记忆条目 */
export interface MemoryEntry {
  key: string;
  content: Record<string, unknown>;
  updatedAt: string;
}

/** 存储后端统一接口 — 对标 ZeroClaw Memory trait */
export interface MemoryStore {
  get(key: string): Promise<MemoryEntry | null>;
  set(key: string, content: Record<string, unknown>): Promise<void>;
  del(key: string): Promise<boolean>;
}

// ========== Supabase 表结构映射 ==========

/** agent_memories 表行类型 */
export interface AgentMemoryRow {
  id: string;
  corp_id: string;
  user_id: string;
  memory_key: string;
  category: string;
  content: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

// ========== 候选人事实提取（从花卷迁移） ==========

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

// ========== 会话记忆状态（从花卷 WeworkSessionState 迁移） ==========

/** 已推荐岗位摘要 — 避免每次回调 API */
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
}

/** 会话记忆状态 — facts 类别的完整结构 */
export interface WeworkSessionState {
  facts: EntityExtractionResult | null;
  /** 每轮覆盖：最后一次 duliday_job_list_for_llm 调用的结果 */
  lastRecommendedJobs: RecommendedJobSummary[] | null;
  /** 最后交互时间 */
  lastInteraction?: string;
  /** 最后话题摘要 */
  lastTopic?: string;
}

// ========== 空值常量 ==========

export const EMPTY_SESSION_STATE: WeworkSessionState = {
  facts: null,
  lastRecommendedJobs: null,
};

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
