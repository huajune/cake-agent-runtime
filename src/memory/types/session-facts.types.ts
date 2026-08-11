import { z } from 'zod';
import { BRAND_INTENT_POLARITIES } from '@resolution/brand/brand-resolution.types';
import type { PersistedBrandState } from '@resolution/brand/brand-resolution.types';
import {
  CANDIDATE_FACT_PRODUCERS,
  type CandidateFactProducer,
} from '@resolution/evidence/claim.types';
import { RecommendedJobSummarySchema, type RecommendedJobSummary } from '@resolution/job/types';
import { FACT_CONFIDENCE_LEVELS_DESC, factConfidenceRank } from './confidence-rank';

// 类型唯一定义在 @resolution/job/types，此处仅作存储侧转发，供既有消费者沿用旧路径。
export {
  RecommendedJobSummarySchema,
  RecommendedJobWelfareFactsSchema,
  RecommendedJobWelfareKindSchema,
} from '@resolution/job/types';
export type {
  RecommendedJobSummary,
  RecommendedJobWelfareFacts,
  RecommendedJobWelfareKind,
} from '@resolution/job/types';

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
  experience: z.string().nullable().optional().describe('过往工作经历（公司/岗位/年限）'),
  upload_resume: z.string().nullable().optional().describe('简历附件 URL'),
  height: z.string().nullable().optional().describe('身高（cm，如 "170"）'),
  weight: z.string().nullable().optional().describe('体重（kg，如 "60"）'),
  household_register_province: z
    .string()
    .nullable()
    .optional()
    .describe('户籍省份（如 "安徽"、"安徽省"）'),
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
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: CityFactEvidenceSchema,
});

export type CityFact = z.infer<typeof CityFactSchema>;
export type CityFactEvidence = z.infer<typeof CityFactEvidenceSchema>;

/**
 * 兼容旧数据的 city 字段解析：
 * - 字符串（旧 Redis 数据、LLM 原始输出）→ 归一化为 `{ value, confidence: 'medium', evidence: 'explicit_city' }`
 * - 对象 → 直接校验为 CityFact
 * - null/空串 → null
 *
 * 拆除判据：A1 及后续复扫中旧 city 字符串/旧 CityFact 形态存量计数均归零后，
 * 删除字符串分支与旧对象兼容；factsv2 无短 TTL，不能以自然过期代替数据侧确认。
 */
const NullableCityFactSchema = z
  .union([CityFactSchema, z.string(), z.null()])
  .transform((value): CityFact | null => {
    if (value === null) return null;
    if (typeof value === 'string') {
      const trimmed = value.trim().replace(/市$/, '');
      return trimmed ? { value: trimmed, confidence: 'medium', evidence: 'explicit_city' } : null;
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
  brand_ids: z
    .array(z.number().int())
    .nullable()
    .optional()
    .describe('意向品牌ID（Boss 岗位标题中的 [brand_id] 数字）'),
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
  brand_ids: z
    .array(z.number().int())
    .nullable()
    .optional()
    .describe('意向品牌ID（Boss 岗位标题中的 [brand_id] 数字；如 "服装导购[10239]" → [10239]）'),
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

/** LLM 声明的"候选人明确提供"字段及其原文证据。 */
export const ExplicitProvenanceEntrySchema = z.object({
  field: z
    .string()
    .describe('interview_info 下的字段名，如 "phone"、"age"、"has_health_certificate"'),
  quote: z
    .string()
    .describe('候选人原话中的逐字片段（必须能在候选人消息里原样找到，否则该声明无效）'),
});

export type ExplicitProvenanceEntry = z.infer<typeof ExplicitProvenanceEntrySchema>;

/**
 * LLM 极性轨输出（§6.3.1）：品牌意图极性 + 指代链接结果。
 * brand 为 null 表示品牌为空的表达（"换个品牌"类 negative / "品牌不限"类 browse_all）。
 * 输出的品牌名必须经品牌库标准化验证后才进 brand_state reducer，未命中即整条丢弃。
 */
export const BrandIntentEntrySchema = z.object({
  brand: z
    .string()
    .nullable()
    .describe(
      '品牌名（尽量使用[可用品牌信息]中的标准名；指代表达须链接到实际品牌名）；' +
        '"换个品牌/这个不考虑"等无具体品牌的排斥填 null',
    ),
  polarity: z
    .enum(BRAND_INTENT_POLARITIES)
    .describe('positive=意向/询问/提及；negative=排斥（含指代排斥）；browse_all=明确不限品牌'),
});

export type BrandIntentEntry = z.infer<typeof BrandIntentEntrySchema>;

/** LLM 结构化输出 schema — city 字段为字符串 */
export const LLMEntityExtractionResultSchema = z.object({
  interview_info: InterviewInfoSchema,
  preferences: LLMPreferencesSchema,
  explicit_provenance: z
    .array(ExplicitProvenanceEntrySchema)
    .nullable()
    .optional()
    .describe(
      '候选人明确提供的 interview_info 字段清单：仅当字段值来自结构化表单回填（「年龄：37」）' +
        '或候选人直接自陈（"我有健康证""我今年37"）时列入，并附逐字原文片段；' +
        '由上下文推断、或助手提及后候选人仅附和的字段一律不列',
    ),
  brand_intents: z
    .array(BrandIntentEntrySchema)
    .nullable()
    .optional()
    .describe(
      '本轮候选人对品牌的意图极性清单（仅本轮新表达，不复读历史）。' +
        '候选人用"这个/那个/第一个/你说的那家"等指代品牌时，必须链接到图片或此前推荐的实际品牌名再输出；' +
        '排斥表达（"X就算了""X干过了不去了""这个不考虑"）输出 negative；明确不限品牌输出 browse_all',
    ),
  reasoning: z
    .string()
    .describe('提取与推理说明：列出每个字段的来源（直接提取/推理得出），推理字段需说明推理链'),
});

/** 实体提取结果类型 */
export type EntityExtractionResult = z.infer<typeof EntityExtractionResultSchema>;
export type InterviewInfo = z.infer<typeof InterviewInfoSchema>;
export type Preferences = z.infer<typeof PreferencesSchema>;

/**
 * ==================== 单一字段清单（schema 体系的唯一字段来源） ====================
 *
 * session facts 的同一批字段过去在 8-10 处各声明一遍（FALLBACK_EXTRACTION 的逐字段 null、
 * toSessionFacts 的 wrap 块、unwrapSessionFacts 的 unwrap 块、turn-hints 的空模板……），
 * 新增字段要改 8-10 处且任何一处漏改都会静默丢字段。
 *
 * 这里把字段清单收敛成两个常量，作为所有"纯样板"（null 模板 / wrap-unwrap 循环）的
 * 唯一驱动来源；并在模块加载期用 assertFieldKeysMirrorSchemas 校验清单与各 zod schema
 * 的 shape keys 完全一致，任何字段漂移（清单漏字段 / schema 多字段）立即抛错。
 *
 * `as const satisfies readonly (keyof ...)[]`：satisfies 锁住"列出的每个 key 都是合法
 * 字段名"（拼错立即编译报错）；完备性（不漏字段）由加载期自检兜底。
 */
export const INTERVIEW_INFO_FIELD_KEYS = [
  'name',
  'phone',
  'gender',
  'gender_source',
  'age',
  'applied_store',
  'applied_position',
  'interview_time',
  'is_student',
  'education',
  'has_health_certificate',
  'experience',
  'upload_resume',
  'height',
  'weight',
  'household_register_province',
] as const satisfies readonly (keyof InterviewInfo)[];

export const PREFERENCE_FIELD_KEYS = [
  'brands',
  'brand_ids',
  'salary',
  'position',
  'schedule',
  'city',
  'district',
  'location',
  'labor_form',
  'delayed_intent',
  'short_term',
  'open_position',
  'time_windows',
  'schedule_constraint',
  'available_after',
] as const satisfies readonly (keyof Preferences)[];

export type InterviewInfoFieldKey = (typeof INTERVIEW_INFO_FIELD_KEYS)[number];
export type PreferenceFieldKey = (typeof PREFERENCE_FIELD_KEYS)[number];

// 降序元组来自 confidence-rank（唯一权威）；顺序沿用历史 high-first，
// 保证发给抽取模型的 JSON schema 逐字节不变。
export const SessionFactConfidenceSchema = z.enum(FACT_CONFIDENCE_LEVELS_DESC);

const LEGACY_SESSION_FACT_PRODUCERS: Readonly<Record<string, CandidateFactProducer>> = {
  candidate: 'candidate_quote',
  llm: 'model',
  rule: 'rule',
  system: 'system',
  memory: 'archive',
  derived: 'rule',
  tool: 'system',
};

/** 存储读边界兼容旧 source；域内只允许六章根词汇，不回写旧行。 */
const StoredCandidateFactProducerSchema = z.preprocess(
  (value) => (typeof value === 'string' ? (LEGACY_SESSION_FACT_PRODUCERS[value] ?? value) : value),
  z.enum(CANDIDATE_FACT_PRODUCERS),
);

export type SessionFactConfidence = z.infer<typeof SessionFactConfidenceSchema>;

/** sessionFacts 置信度语义。工具消费默认只信 high；prompt 会展示所有置信度。 */
export const SESSION_FACT_CONFIDENCE_DESCRIPTIONS: Record<SessionFactConfidence, string> = {
  high: '可程序化采用。来自确定性规则、明确结构化输入，或经过强校验的事实。',
  medium: '可给模型参考。通常来自 LLM 结构化提取或会话沉淀，可能需要结合上下文判断。',
  low: '弱参考。来自系统兜底、弱规则或补充接口，不应直接用于筛人、约面等硬判断。',
  unknown: '旧数据或缺少元数据的兼容值。只能作为背景信息，工具默认不消费。',
};

/** sessionFacts 来源语义。source 说明事实出身，不等同于字段真假。 */
export const SESSION_FACT_SOURCE_DESCRIPTIONS: Record<CandidateFactProducer, string> = {
  candidate_quote: '候选人直接明示且经原话复算或答问绑定确认。',
  rule: '确定性规则、正则、白名单或别名表匹配得到。',
  model: 'LLM 根据对话做的结构化提取或模型工具入参。',
  system: '外部系统或平台接口补充得到。',
  manual: '真人经理带外裁决。',
  archive: '历史记忆或跨会话档案回放得到。',
};

/** 持久化 sessionFacts 字段值：字段自身携带置信度、来源和证据。 */
export interface SessionFactValue<T> {
  value: T;
  confidence: SessionFactConfidence;
  source: CandidateFactProducer;
  evidence: string;
  /** 该值被提取/写入的时刻（ISO8601）。时间敏感字段（如面试时间）渲染时据此标注陈旧度。 */
  extractedAt?: string;
}

/**
 * evidence 入库前截断。
 *
 * evidence 只服务排障（memory_snapshot / Supabase 查询），不是给模型看的。
 * 历史问题：LLM 提取 reasoning 全文（600+ 字）被当 evidence 存进每个字段，
 * 再经沉淀永久写入长期画像，最终整段重复注入 system prompt（张漪 case，
 * chat 69a13e919d6d3a463b0a37c6，单轮 system prompt 被撑到 27K+ 字符）。
 */
export const MAX_FACT_EVIDENCE_CHARS = 200;

export function truncateEvidence(evidence: string, maxChars = MAX_FACT_EVIDENCE_CHARS): string {
  const trimmed = evidence.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}…`;
}

export type SessionFactMaybeValue<T> = SessionFactValue<T> | null;

export interface SessionInterviewInfo {
  name: SessionFactMaybeValue<string>;
  phone: SessionFactMaybeValue<string>;
  gender: SessionFactMaybeValue<string>;
  gender_source: SessionFactMaybeValue<'candidate' | 'system'>;
  age: SessionFactMaybeValue<string>;
  applied_store: SessionFactMaybeValue<string>;
  applied_position: SessionFactMaybeValue<string>;
  interview_time: SessionFactMaybeValue<string>;
  is_student: SessionFactMaybeValue<boolean>;
  education: SessionFactMaybeValue<string>;
  has_health_certificate: SessionFactMaybeValue<string>;
  experience?: SessionFactMaybeValue<string>;
  upload_resume?: SessionFactMaybeValue<string>;
  height?: SessionFactMaybeValue<string>;
  weight?: SessionFactMaybeValue<string>;
  household_register_province?: SessionFactMaybeValue<string>;
}

export interface SessionPreferences {
  brands: SessionFactMaybeValue<string[]>;
  brand_ids?: SessionFactMaybeValue<number[]>;
  salary: SessionFactMaybeValue<string>;
  position: SessionFactMaybeValue<string[]>;
  schedule: SessionFactMaybeValue<string>;
  city: SessionFactMaybeValue<string>;
  district: SessionFactMaybeValue<string[]>;
  location: SessionFactMaybeValue<string[]>;
  labor_form: SessionFactMaybeValue<string>;
  delayed_intent: SessionFactMaybeValue<DelayedIntent>;
  short_term: SessionFactMaybeValue<boolean>;
  open_position: SessionFactMaybeValue<boolean>;
  time_windows: SessionFactMaybeValue<string[]>;
  schedule_constraint: SessionFactMaybeValue<ScheduleConstraintFact>;
  available_after: SessionFactMaybeValue<AvailableAfterFact>;
}

export type SessionFacts = Omit<EntityExtractionResult, 'interview_info' | 'preferences'> & {
  interview_info: SessionInterviewInfo;
  preferences: SessionPreferences;
};

const SessionFactValueSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z.object({
    value: valueSchema,
    confidence: SessionFactConfidenceSchema,
    source: StoredCandidateFactProducerSchema,
    evidence: z.string(),
    extractedAt: z.string().optional(),
  });

/**
 * 裸值兼容信封。拆除判据：A1 及后续复扫中 unknown/memory 旧档计数归零后删除；
 * factsv2 无短 TTL，不能以自然过期代替数据侧确认。
 */
function legacySessionFactValue<T>(value: T, evidence?: string): SessionFactValue<T> {
  return {
    value,
    confidence: 'unknown',
    source: 'archive',
    evidence: evidence ?? '旧 sessionFacts 兼容迁移：字段缺少置信度元数据',
  };
}

const NullableSessionFactSchema = <T extends z.ZodTypeAny>(valueSchema: T) =>
  z
    .union([SessionFactValueSchema(valueSchema), valueSchema, z.null()])
    .transform((value): SessionFactValue<z.infer<T>> | null => {
      if (value === null) return null;
      return isSessionFactValue(value)
        ? (value as SessionFactValue<z.infer<T>>)
        : legacySessionFactValue(value as z.infer<T>);
    });

function cityEvidenceToString(evidence: CityFactEvidence): string {
  return evidence;
}

const NullableSessionCityFactSchema = z
  .union([SessionFactValueSchema(z.string()), CityFactSchema, z.string(), z.null()])
  .transform((value): SessionFactValue<string> | null => {
    if (value === null) return null;
    if (typeof value === 'string') {
      const city = value.trim().replace(/市$/, '');
      return city ? legacySessionFactValue(city, '旧 sessionFacts city 字符串兼容迁移') : null;
    }
    if (isSessionFactValue(value)) return value as SessionFactValue<string>;
    const cityFact = value as CityFact;
    return {
      value: cityFact.value,
      confidence: cityFact.confidence,
      source: 'rule',
      evidence: cityEvidenceToString(cityFact.evidence),
    };
  });

export const SessionInterviewInfoSchema = z.object({
  name: NullableSessionFactSchema(z.string()),
  phone: NullableSessionFactSchema(z.string()),
  gender: NullableSessionFactSchema(z.string()),
  gender_source: NullableSessionFactSchema(z.enum(['candidate', 'system'])),
  age: NullableSessionFactSchema(z.string()),
  applied_store: NullableSessionFactSchema(z.string()),
  applied_position: NullableSessionFactSchema(z.string()),
  interview_time: NullableSessionFactSchema(z.string()),
  is_student: NullableSessionFactSchema(z.boolean()),
  education: NullableSessionFactSchema(z.string()),
  has_health_certificate: NullableSessionFactSchema(z.string()),
  experience: NullableSessionFactSchema(z.string()).optional(),
  upload_resume: NullableSessionFactSchema(z.string()).optional(),
  height: NullableSessionFactSchema(z.string()).optional(),
  weight: NullableSessionFactSchema(z.string()).optional(),
  household_register_province: NullableSessionFactSchema(z.string()).optional(),
});

export const SessionPreferencesSchema = z.object({
  brands: NullableSessionFactSchema(z.array(z.string())),
  brand_ids: NullableSessionFactSchema(z.array(z.number().int())).optional(),
  salary: NullableSessionFactSchema(z.string()),
  position: NullableSessionFactSchema(z.array(z.string())),
  schedule: NullableSessionFactSchema(z.string()),
  city: NullableSessionCityFactSchema,
  district: NullableSessionFactSchema(z.array(z.string())),
  location: NullableSessionFactSchema(z.array(z.string())),
  labor_form: NullableSessionFactSchema(z.string()),
  delayed_intent: NullableSessionFactSchema(DelayedIntentSchema),
  short_term: NullableSessionFactSchema(z.boolean()),
  open_position: NullableSessionFactSchema(z.boolean()),
  time_windows: NullableSessionFactSchema(z.array(z.string())),
  schedule_constraint: NullableSessionFactSchema(ScheduleConstraintFactSchema),
  available_after: NullableSessionFactSchema(AvailableAfterFactSchema),
});

export const SessionFactsSchema = z.object({
  interview_info: SessionInterviewInfoSchema,
  preferences: SessionPreferencesSchema,
  reasoning: z.string(),
});

/** 由字段清单生成"逐字段 null"对象（所有字段 schema 均 nullable，null 是合法降级值）。 */
function nullFieldRecord<K extends string>(keys: readonly K[]): Record<K, null> {
  return Object.fromEntries(keys.map((key) => [key, null])) as Record<K, null>;
}

/**
 * 实体提取失败时的降级结果。
 *
 * interview_info / preferences 的逐字段 null 由单一字段清单生成，不再手写；
 * 加载期 assertFieldKeysMirrorSchemas 保证清单与 schema 一致，因此生成结果与
 * 各 schema 的字段集完全对齐。`satisfies` 锁住整体形状仍符合 EntityExtractionResult。
 */
export const FALLBACK_EXTRACTION: EntityExtractionResult = {
  interview_info: nullFieldRecord(INTERVIEW_INFO_FIELD_KEYS),
  preferences: nullFieldRecord(PREFERENCE_FIELD_KEYS),
  reasoning: '实体提取失败，使用空值降级',
} satisfies EntityExtractionResult;

/**
 * 字段清单完备性自检（加载期执行）。
 *
 * 单一字段清单（INTERVIEW_INFO_FIELD_KEYS / PREFERENCE_FIELD_KEYS）驱动所有纯样板，
 * 但 `as const satisfies` 只能保证"列出的 key 合法"，不能保证"没漏字段"。
 * 这里把清单与所有承载同批字段的 zod schema 的 shape keys 做集合比对：
 * 任一 schema 多出或缺少字段、或清单漏字段，都会在模块加载（任意测试运行 / 启动）时抛错，
 * 把"新增字段漏改某处"从运行期静默丢字段提前到加载期失败。
 *
 * 参考 rule-track claim 注册表的完备性自检模式。
 */
function assertFieldKeysMirrorSchemas(): void {
  const sameKeySet = (expected: readonly string[], actual: readonly string[]): string[] => {
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((key) => !actualSet.has(key)).map((key) => `-${key}`);
    const extra = actual.filter((key) => !expectedSet.has(key)).map((key) => `+${key}`);
    return [...missing, ...extra];
  };

  const checks: { label: string; expected: readonly string[]; shape: Record<string, unknown> }[] = [
    {
      label: 'InterviewInfoSchema',
      expected: INTERVIEW_INFO_FIELD_KEYS,
      shape: InterviewInfoSchema.shape,
    },
    {
      label: 'SessionInterviewInfoSchema',
      expected: INTERVIEW_INFO_FIELD_KEYS,
      shape: SessionInterviewInfoSchema.shape,
    },
    {
      label: 'PreferencesSchema',
      expected: PREFERENCE_FIELD_KEYS,
      shape: PreferencesSchema.shape,
    },
    {
      label: 'LLMPreferencesSchema',
      expected: PREFERENCE_FIELD_KEYS,
      shape: LLMPreferencesSchema.shape,
    },
    {
      label: 'SessionPreferencesSchema',
      expected: PREFERENCE_FIELD_KEYS,
      shape: SessionPreferencesSchema.shape,
    },
  ];

  const failures: string[] = [];
  for (const { label, expected, shape } of checks) {
    const diff = sameKeySet(expected, Object.keys(shape));
    if (diff.length > 0) failures.push(`${label}: ${diff.join(' ')}`);
  }

  if (failures.length > 0) {
    throw new Error(
      `[session-facts.types] 字段清单与 schema shape 失配（-缺失/+多余），新增字段须同步字段清单：\n${failures.join('\n')}`,
    );
  }
}

assertFieldKeysMirrorSchemas();

/** 置信度排序值。供跨轮合并守卫比较新旧事实的可信级别（权威定义见 confidence-rank.ts）。 */
export function sessionFactConfidenceRank(confidence: SessionFactConfidence): number {
  return factConfidenceRank(confidence);
}

export function isSessionFactValue<T = unknown>(value: unknown): value is SessionFactValue<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'value' in value &&
    'confidence' in value &&
    'source' in value &&
    'evidence' in value
  );
}

export function sessionFactValue<T>(
  value: T,
  meta: {
    confidence: SessionFactConfidence;
    source: CandidateFactProducer;
    evidence: string;
    extractedAt?: string;
  },
): SessionFactValue<T> {
  return { value, ...meta };
}

export function unwrapSessionFactValue<T>(
  value: SessionFactValue<T> | T | null | undefined,
  options: { minConfidence?: SessionFactConfidence } = {},
): T | null {
  if (value === null || value === undefined) return null;
  if (!isSessionFactValue<T>(value)) return value;
  const minConfidence = options.minConfidence;
  if (minConfidence && factConfidenceRank(value.confidence) < factConfidenceRank(minConfidence)) {
    return null;
  }
  return value.value;
}

function cityFactFromSessionValue(value: SessionFactValue<string>): CityFact | null {
  if (!value.value.trim()) return null;
  return {
    value: value.value.trim().replace(/市$/, ''),
    confidence: value.confidence === 'low' ? 'low' : 'high',
    evidence: 'explicit_city',
  };
}

export function unwrapSessionFacts(
  facts: SessionFacts | EntityExtractionResult | null | undefined,
  options: { minConfidence?: SessionFactConfidence } = {},
): EntityExtractionResult | null {
  if (!facts) return null;

  const city = facts.preferences.city;
  const unwrappedCity = isSessionFactValue<string>(city)
    ? unwrapSessionFactValue(city, options)
    : null;

  // 字段清单驱动：interview_info 全字段 + preferences 非 city 字段统一 unwrap；
  // city 携带 CityFact 结构（confidence/evidence），保留下方显式分支单独处理。
  const interviewInfoSource = facts.interview_info as Record<string, unknown>;
  const preferencesSource = facts.preferences as Record<string, unknown>;
  const interview_info = Object.fromEntries(
    INTERVIEW_INFO_FIELD_KEYS.map((key) => [
      key,
      unwrapSessionFactValue(interviewInfoSource[key], options),
    ]),
  );
  const preferences = Object.fromEntries(
    PREFERENCE_FIELD_KEYS.filter((key) => key !== 'city').map((key) => [
      key,
      unwrapSessionFactValue(preferencesSource[key], options),
    ]),
  );

  return EntityExtractionResultSchema.parse({
    interview_info,
    preferences: {
      ...preferences,
      city: isSessionFactValue<string>(city)
        ? unwrappedCity
          ? cityFactFromSessionValue({ ...city, value: unwrappedCity })
          : null
        : city,
    },
    reasoning: facts.reasoning,
  });
}

export function toSessionFacts(
  facts: EntityExtractionResult,
  meta: {
    confidence: SessionFactConfidence;
    source: CandidateFactProducer;
    evidence: string;
    extractedAt?: string;
  },
): SessionFacts {
  const wrap = <T>(value: T | null): SessionFactMaybeValue<T> =>
    value === null || value === undefined ? null : sessionFactValue(value, meta);

  // 字段清单驱动：interview_info 全字段 + preferences 非 city 字段统一 wrap；
  // city 需要带上 CityFact 的 confidence/evidence 与 model→rule 来源改写，保留显式分支。
  const interviewInfoSource = facts.interview_info as Record<string, unknown>;
  const preferencesSource = facts.preferences as Record<string, unknown>;
  const interview_info = Object.fromEntries(
    INTERVIEW_INFO_FIELD_KEYS.map((key) => [key, wrap(interviewInfoSource[key] ?? null)]),
  );
  const preferences = Object.fromEntries(
    PREFERENCE_FIELD_KEYS.filter((key) => key !== 'city').map((key) => [
      key,
      wrap(preferencesSource[key] ?? null),
    ]),
  );

  return SessionFactsSchema.parse({
    interview_info,
    preferences: {
      ...preferences,
      city: facts.preferences.city
        ? sessionFactValue(facts.preferences.city.value, {
            ...meta,
            confidence: facts.preferences.city.confidence,
            source: meta.source === 'model' ? 'rule' : meta.source,
            evidence: cityEvidenceToString(facts.preferences.city.evidence),
          })
        : null,
    },
    reasoning: facts.reasoning,
  }) as SessionFacts;
}

// ==================== 2. 业务状态（当前会话的结构化短期记忆） ====================

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

/**
 * 会话终态（复聊停止条件的权威信号）。
 *
 * ⚠️ 加档必须走本常量：Redis 落盘校验 SessionFactsRedisContentSchema 用的就是它。
 * 写侧 interface 放行而读侧 z.enum 不认时，getSessionState 的 safeParse 失败会
 * **整份会话状态归 EMPTY_SESSION_STATE**（facts/池/brand_state 全丢）且只留一条
 * warn，终态随之丢失、复聊继续触达已终态候选人。
 */
export const SESSION_TERMINAL_STATES = ['booked', 'handed_off', 'rejected', 'onboarded'] as const;
export type SessionTerminalState = (typeof SESSION_TERMINAL_STATES)[number];

/**
 * 最近一次 duliday_job_list 的查询签名记录。
 * 供工具跨轮比对"本轮查询与上一轮是否有实质差异"——签名相同即结果必然相同，
 * 模型必须实质调整查询或按既有拉群优先阶梯兜底，不得复读
 * （badcase 6a5dc7c4ce406a6aee57bf6d）。
 */
export interface JobListQueryRecord {
  /** 归一化过滤条件的稳定序列化（见 tools/shared/job-list-query-signature.ts）。 */
  signature: string;
  /** 执行该查询的 turnId（= 触发消息 messageId）；用于排除同轮 Bull 重试误判。 */
  turnId: string | null;
  updatedAtMs?: number | null;
}

/** 会话事实层 — 当前这次求职会话的结构化状态 */
export interface WeworkSessionState {
  facts: SessionFacts | null;
  /** 每轮覆盖：最后一次 duliday_job_list 调用返回的候选岗位池 */
  lastCandidatePool: RecommendedJobSummary[] | null;
  /** 最近几轮真正发给候选人的岗位 */
  presentedJobs: RecommendedJobSummary[] | null;
  /** 候选人当前明确在聊或准备报名的岗位 */
  currentFocusJob: RecommendedJobSummary | null;
  /** 本会话中已邀入的兼职群 */
  invitedGroups: InvitedGroupRecord[] | null;
  /** 会话终态（已约面/已转人工/已拒绝/已入职）；复聊 shouldStop 据此停发。可选：旧数据无此键。 */
  terminal?: SessionTerminalState | null;
  /** 候选人最后一次入站消息时间（ISO）；复聊 shouldStop 用「锚点后已回话」停发。可选：旧数据无此键。 */
  lastCandidateMessageAt?: string | null;
  /**
   * 已被系统成功处理（正常回复或有意沉默）的候选人消息时间水位（ISO）。
   * 与 lastCandidateMessageAt 比对可识别被 timeout 静默丢弃的回话（复聊停止判定用）。
   * 可选：旧数据无此键。
   */
  lastProcessedCandidateMessageAt?: string | null;
  /**
   * 会话品牌状态（currentBrand + excludedBrands，§9）：品牌真相的唯一存储。
   * 写入只经 brand_state reducer（回合收尾 apply_brand_state + 图片描述晚到补写
   * applyLateImageResolutions 两个时机）；preferences.brands 已退役（§19.6），读边界恒 null。
   * 可选：旧数据无此键（懒迁移，见 §9.4）。
   */
  brand_state?: PersistedBrandState | null;
  /** 最近一次 duliday_job_list 查询签名（跨轮重复查询检测）。可选：旧数据无此键。 */
  lastJobListQuery?: JobListQueryRecord | null;
}

export const InvitedGroupRecordSchema = z.object({
  groupName: z.string(),
  city: z.string(),
  industry: z.string().optional(),
  invitedAt: z.string(),
});

export const SessionBrandRefSchema = z.object({
  canonicalName: z.string(),
  brandId: z.number().int().nullable(),
});

/** brand_state 的 Redis 落盘 schema（未注册进 SessionFactsRedisContentSchema 的字段会被丢弃）。 */
export const PersistedBrandStateSchema = z.object({
  currentBrand: SessionBrandRefSchema.nullable(),
  excludedBrands: z.array(SessionBrandRefSchema),
  updatedAtMs: z.number().nullable().optional(),
});

export const JobListQueryRecordSchema = z.object({
  signature: z.string(),
  turnId: z.string().nullable(),
  updatedAtMs: z.number().nullable().optional(),
});

export const WeworkSessionStateSchema = z.object({
  facts: SessionFactsSchema.nullable(),
  lastCandidatePool: z.array(RecommendedJobSummarySchema).nullable(),
  presentedJobs: z.array(RecommendedJobSummarySchema).nullable(),
  currentFocusJob: RecommendedJobSummarySchema.nullable(),
  invitedGroups: z.array(InvitedGroupRecordSchema).nullable(),
  terminal: z.enum(SESSION_TERMINAL_STATES).nullable().optional(),
  lastCandidateMessageAt: z.string().nullable().optional(),
  lastProcessedCandidateMessageAt: z.string().nullable().optional(),
  brand_state: PersistedBrandStateSchema.nullable().optional(),
  lastJobListQuery: JobListQueryRecordSchema.nullable().optional(),
});

/** 当前会话没有任何结构化记忆时的空状态。 */
export const EMPTY_SESSION_STATE: WeworkSessionState = {
  facts: null,
  lastCandidatePool: null,
  presentedJobs: null,
  currentFocusJob: null,
  invitedGroups: null,
  terminal: null,
  lastCandidateMessageAt: null,
  lastProcessedCandidateMessageAt: null,
  brand_state: null,
  lastJobListQuery: null,
};

// ==================== 3. Redis 持久化结构 ====================

/** Redis 中 session-facts 层实际写入的 content 结构。 */
export type SessionFactsRedisContent = Partial<WeworkSessionState>;

export const SessionFactsRedisContentSchema = WeworkSessionStateSchema.partial();
