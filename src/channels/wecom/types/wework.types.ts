/**
 * 企微 Agent 类型定义
 *
 * 迁移自原 agent 模块:
 * - types/reply-policy.ts → 漏斗阶段、回复需求、风险标记、回合规划
 * - lib/tools/wework/types.ts → 实体提取、计划输出
 * - lib/memory/wework/session-memory.ts → 会话状态、推荐岗位摘要
 *
 * 设计原则：
 * - Zod schema 用于运行时验证（分类 Agent、事实提取）
 * - 纯 TS 类型用于编译期检查
 * - 企微场景 channelType 默认 "private"，排除 private_channel 阶段
 */

import { z } from 'zod';
import { ModelMessage } from 'ai';

// ==================== 漏斗阶段 (Funnel Stage) ====================

export const FunnelStageSchema = z.enum([
  'trust_building',
  'private_channel',
  'qualify_candidate',
  'job_consultation',
  'interview_scheduling',
  'onboard_followup',
]);

export type FunnelStage = z.infer<typeof FunnelStageSchema>;

export const ChannelTypeSchema = z.enum(['public', 'private']);
export type ChannelType = z.infer<typeof ChannelTypeSchema>;

export interface StageDefinition {
  description: string;
  transitionSignal: string;
  applicableChannels: readonly ChannelType[];
}

export const STAGE_DEFINITIONS: Record<FunnelStage, StageDefinition> = {
  trust_building: {
    description: '初次接触，建立信任并了解求职意向',
    transitionSignal: '候选人表达明确兴趣或开始询问具体岗位信息',
    applicableChannels: ['public', 'private'],
  },
  private_channel: {
    description: '引导用户从公域平台转入微信私聊',
    transitionSignal: '候选人有继续深入了解的意愿，适合引导到私域',
    applicableChannels: ['public'],
  },
  qualify_candidate: {
    description: '确认候选人基本匹配度（年龄、时间、岗位条件）',
    transitionSignal: '候选人表达求职意向后，需要核实基本资格',
    applicableChannels: ['public', 'private'],
  },
  job_consultation: {
    description: '回答岗位相关问题（薪资、排班、地点等）并提升兴趣',
    transitionSignal: '候选人主动询问岗位细节',
    applicableChannels: ['public', 'private'],
  },
  interview_scheduling: {
    description: '推动面试预约，确认时间和到店安排',
    transitionSignal: '候选人核心问题已解答，准备推进面试',
    applicableChannels: ['public', 'private'],
  },
  onboard_followup: {
    description: '促进到岗并保持回访',
    transitionSignal: '候选人确认上岗安排',
    applicableChannels: ['public', 'private'],
  },
};

// ==================== 回复需求 (Reply Need) ====================

export const ReplyNeedSchema = z.enum([
  'stores',
  'location',
  'salary',
  'schedule',
  'policy',
  'availability',
  'requirements',
  'interview',
  'wechat',
  'none',
]);

export type ReplyNeed = z.infer<typeof ReplyNeedSchema>;

// ==================== 风险标记 (Risk Flag) ====================

export const RiskFlagSchema = z.enum([
  'insurance_promise_risk',
  'age_sensitive',
  'confrontation_emotion',
  'urgency_high',
  'qualification_mismatch',
]);

export type RiskFlag = z.infer<typeof RiskFlagSchema>;

// ==================== 回合规划 (Turn Plan) ====================

export const TurnExtractedInfoSchema = z.object({
  mentionedBrand: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  mentionedLocations: z
    .array(z.object({ location: z.string(), confidence: z.number().min(0).max(1) }))
    .nullable()
    .optional(),
  mentionedDistricts: z
    .array(z.object({ district: z.string(), confidence: z.number().min(0).max(1) }))
    .max(10)
    .nullable()
    .optional(),
  specificAge: z.number().nullable().optional(),
  hasUrgency: z.boolean().nullable().optional(),
  preferredSchedule: z.string().nullable().optional(),
});

export type TurnExtractedInfo = z.infer<typeof TurnExtractedInfoSchema>;

export const TurnPlanSchema = z.object({
  stage: FunnelStageSchema,
  subGoals: z.array(z.string()).max(6),
  needs: z.array(ReplyNeedSchema).max(8),
  riskFlags: z.array(RiskFlagSchema).max(6),
  confidence: z.number().min(0).max(1),
  extractedInfo: TurnExtractedInfoSchema,
  reasoningText: z.string(),
});

export type TurnPlan = z.infer<typeof TurnPlanSchema>;

// ==================== 阶段目标策略 (Stage Goal Policy) ====================

export const StageGoalPolicySchema = z.object({
  description: z.string().optional(),
  primaryGoal: z.string(),
  successCriteria: z.array(z.string()),
  ctaStrategy: z.preprocess(
    (val) => (Array.isArray(val) ? (val as string[]).join('\n') : val),
    z.string(),
  ),
  disallowedActions: z.array(z.string()).optional(),
});

export type StageGoalPolicy = z.infer<typeof StageGoalPolicySchema>;

export type StageGoals = Record<FunnelStage, StageGoalPolicy>;

// ==================== Plan Turn 输出 ====================

export interface WeworkPlanTurnOutput {
  stage: FunnelStage;
  needs: ReplyNeed[];
  riskFlags: RiskFlag[];
  confidence: number;
  reasoning: string;
  stageGoal: StageGoalPolicy;
}

// ==================== 实体提取 (Entity Extraction) ====================

export const InterviewInfoSchema = z.object({
  name: z.string().nullable().describe('姓名'),
  phone: z.string().nullable().describe('联系方式'),
  gender: z.string().nullable().describe('性别'),
  age: z.string().nullable().describe('年龄（保留原话）'),
  applied_store: z.string().nullable().describe('应聘门店'),
  applied_position: z.string().nullable().describe('应聘岗位'),
  interview_time: z.string().nullable().describe('面试时间'),
  is_student: z.boolean().nullable().describe('是否是学生'),
  education: z.string().nullable().describe('学历'),
  has_health_certificate: z.string().nullable().describe('是否有健康证'),
});

export type InterviewInfo = z.infer<typeof InterviewInfoSchema>;

export const PreferencesSchema = z.object({
  brands: z.array(z.string()).nullable().describe('意向品牌'),
  salary: z.string().nullable().describe('意向薪资'),
  position: z.array(z.string()).nullable().describe('意向岗位'),
  schedule: z.string().nullable().describe('意向班次/时间'),
  city: z.string().nullable().describe('意向城市'),
  district: z.array(z.string()).nullable().describe('意向区域'),
  location: z.array(z.string()).nullable().describe('意向地点/商圈'),
  labor_form: z.string().nullable().describe('用工形式'),
});

export type Preferences = z.infer<typeof PreferencesSchema>;

export const EntityExtractionResultSchema = z.object({
  interview_info: InterviewInfoSchema,
  preferences: PreferencesSchema,
  reasoning: z.string().describe('提取与推理说明'),
});

export type EntityExtractionResult = z.infer<typeof EntityExtractionResultSchema>;

// ==================== 品牌数据 ====================

export interface BrandInfo {
  name: string;
  aliases: string[];
}

export type BrandDataList = BrandInfo[];

// ==================== 会话记忆 (Session Memory) ====================

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

export interface WeworkSessionState {
  facts: EntityExtractionResult | null;
  lastRecommendedJobs: RecommendedJobSummary[] | null;
}

export const EMPTY_SESSION_STATE: WeworkSessionState = {
  facts: null,
  lastRecommendedJobs: null,
};

// ==================== 工具上下文 (NestJS 请求级) ====================

export interface WeworkToolContext {
  /** 对话消息列表（Vercel AI SDK 格式） */
  messages: ModelMessage[];
  /** 会话记忆 */
  sessionMemory: WeworkSessionState | null;
  /** 外部用户 ID */
  userId: string;
  /** 企业 ID */
  corpId: string;
  /** DuLiDay API Token */
  dulidayToken: string;
  /** 渠道类型，默认 private */
  channelType: ChannelType;
  /** 岗位查询后回调（更新推荐岗位记忆） */
  onJobsFetched?: (jobIds: RecommendedJobSummary[]) => void;
}

// ==================== 需求检测规则 ====================

export interface NeedRule {
  need: ReplyNeed;
  patterns: RegExp[];
}

export const NEED_RULES: NeedRule[] = [
  { need: 'salary', patterns: [/薪资|工资|时薪|底薪|提成|奖金|补贴|多少钱|收入/i] },
  { need: 'schedule', patterns: [/排班|班次|几点|上班|下班|工时|周末|节假日|做几天/i] },
  { need: 'policy', patterns: [/五险一金|社保|保险|合同|考勤|迟到|补班|试用期/i] },
  { need: 'availability', patterns: [/还有名额|空位|可用时段|什么时候能上|明天能面/i] },
  { need: 'location', patterns: [/在哪|位置|地址|附近|地铁|门店|哪个区|多远/i] },
  { need: 'stores', patterns: [/门店|哪家店|哪些店|有店吗/i] },
  { need: 'requirements', patterns: [/要求|条件|年龄|经验|学历|健康证|身高|体重/i] },
  { need: 'interview', patterns: [/面试|到店|约时间|约面/i] },
  { need: 'wechat', patterns: [/微信|vx|私聊|联系方式|加你/i] },
];
