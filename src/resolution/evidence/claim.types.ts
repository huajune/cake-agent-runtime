import { z } from 'zod';

/**
 * 候选人事实声明（CandidateFactClaim）——候选人资料证据化方案 §4.1 的落地类型。
 *
 * 设计定位：模型、规则提取器和确认解析器不再各自输出裸值，而是输出统一的
 * "有出处的主张"：值 + 操作语义 + 生产者 + 解释方式 + 候选人原话证据。
 * 裁决器（candidate-fact-adjudicator）对 claim 做确定性验证后才允许其进入
 * 报名链路（precheck checklist / booking payload）。
 *
 * 与 HC-2（CollectedField/producer 白名单）的关系：本类型是 HC-2 骨架的升级
 * 收编——CollectedField 只回答"值从哪条链路来"，Claim 额外回答"操作语义是什么、
 * 凭哪段原话、如何被解释"，并让每次采信/拒绝产生可审计的裁决记录。
 *
 * 证据锚定说明：方案 §4.1 的 evidence.candidateMessageId 依赖稳定消息标识，而
 * 当前消息管道（ShortTermMessage / ToolBuildContext.messages）没有稳定 id，只有
 * 数组位置。因此验证主体是 quote——逐字片段必须能在候选人消息原文（剥引用块与
 * 时间后缀后）中找到，找不到即 rejected。messageIndex 仅作排障辅助定位，不参与
 * 验证，消息管道未来引入稳定 id 后可无缝替换。
 */

/** 参与 Claim 裁决的候选人报名字段（方案 §4.1 十字段）。 */
export const CANDIDATE_CLAIM_FIELDS = [
  'name',
  'phone',
  'gender',
  'age',
  'isStudent',
  'education',
  'healthCertificate',
  'height',
  'weight',
  'householdProvince',
] as const;

export type CandidateClaimField = (typeof CANDIDATE_CLAIM_FIELDS)[number];

/**
 * 全库唯一「谁说的」词汇。取名判据：每个名字能自然填进「这个值是____来的」。
 *
 * 待遇判据：只有在策略表里受到不同待遇的来源才配单列一章；同待遇的机制差别
 * （例如 geocode / 定位分享 / 地图截图）只写进 evidence，不扩充 producer 词表。
 * 自陈、答问与推导的差别写 interpretation；booking 与 enrichment 的质量差别写
 * confidence。
 */
export type CandidateFactProducer =
  | 'candidate_quote' // 候选人原话来的：自陈 quote 复算或答问绑定问句
  | 'rule' // 规则算出来的：正则、别名表或白名单推导
  | 'model' // 模型提出来的：LLM 结构化提取或模型工具入参
  | 'system' // 外部系统查来的：geocode、报名回填或画像接口补全
  | 'manual' // 人工定的：我方真人带外拍板（预留，暂无写入方）
  | 'archive'; // 档案搬来的：跨会话档案回放

/** 存储 schema 复用根词汇，禁止在各域重新枚举 producer。 */
export const CANDIDATE_FACT_PRODUCERS = [
  'candidate_quote',
  'rule',
  'model',
  'system',
  'manual',
  'archive',
] as const satisfies readonly CandidateFactProducer[];

/** rule-track 仍会产出的完整字段路径；路径本身消除 interview/preferences 同名歧义。 */
export const RULE_FACT_FIELD_PATHS = [
  'interview_info.name',
  'interview_info.phone',
  'interview_info.gender',
  'interview_info.gender_source',
  'interview_info.age',
  'interview_info.is_student',
  'interview_info.education',
  'interview_info.has_health_certificate',
  'interview_info.experience',
  'interview_info.upload_resume',
  'interview_info.height',
  'interview_info.weight',
  'interview_info.household_register_province',
  'preferences.salary',
  'preferences.position',
  'preferences.schedule',
  'preferences.city',
  'preferences.district',
  'preferences.location',
  'preferences.labor_form',
  'preferences.schedule_constraint',
  'preferences.available_after',
] as const;
export type RuleFactFieldPath = (typeof RULE_FACT_FIELD_PATHS)[number];

export function isCandidateClaimField(value: string): value is CandidateClaimField {
  return (CANDIDATE_CLAIM_FIELDS as readonly string[]).includes(value);
}

/**
 * 操作语义：
 * - set：首次提供或常规更新；
 * - correct：明确纠正既有值（"不是张伟，是张玮"）；
 * - confirm：确认既有值仍有效（绑定 Agent 确认问句的肯定应答）；
 * - clear：明确否定/清除既有值（"电话别用之前那个"）。clear 不依赖
 *   "null 不覆盖"合并语义，是显式操作（方案 §5.3-3）。
 */
export const CANDIDATE_FACT_OPERATIONS = ['set', 'correct', 'confirm', 'clear'] as const;
export type CandidateFactOperation = (typeof CANDIDATE_FACT_OPERATIONS)[number];

/**
 * 解释方式：
 * - direct：原话直接给出（"我叫王玥"）；
 * - normalized：确定性归一化（"一米六三"→163）；
 * - context_confirmation：绑定确认问句的应答（"对"确认的是被问字段）；
 * - derived：由其他字段确定性推导（预留位，当前无生产方）。
 */
export type CandidateFactInterpretation =
  | 'direct'
  | 'normalized'
  | 'context_confirmation'
  | 'derived';

export interface CandidateFactEvidence {
  /**
   * 候选人原话逐字片段（剥引用块/时间后缀后）。裁决器验证其必须能在本会话
   * 候选人消息文本中原样找到；找不到该 claim 直接 rejected。
   */
  quote: string;
  /** 确认式 claim 绑定的 Agent 问句片段（context_confirmation 必填）。 */
  agentQuestionQuote?: string;
  /** 排障辅助：来源消息在会话窗口中的数组位置。不参与验证。 */
  messageIndex?: number;
}

export interface FactClaim<
  T = unknown,
  TField extends string = string,
  TProducer extends string = string,
  TEvidence extends CandidateFactEvidence = CandidateFactEvidence,
> {
  /** 会话内唯一：`{producer}_{field}_{序号}`，由 producer 统一生成。 */
  claimId: string;
  field: TField;
  /** clear 操作时为 null。 */
  value: T | null;
  operation: CandidateFactOperation;
  producer: TProducer;
  interpretation: CandidateFactInterpretation;
  evidence: TEvidence;
  /** 生产者附注（模型 claim 的推理说明等），仅审计用。 */
  reasoning?: string;
  /** ISO8601。 */
  assertedAt: string;
}

export type CandidateFactClaim<T = unknown> = FactClaim<
  T,
  CandidateClaimField,
  Extract<CandidateFactProducer, 'candidate_quote' | 'rule' | 'model' | 'manual'>
>;

export type RuleFactConfidence = 'high' | 'medium' | 'low';

export interface RuleFactEvidence extends CandidateFactEvidence {
  /** 旧规则轨 evidence 的人类可读标签；供 prompt 与持久化元数据直接复用。 */
  label: string;
  /** city 等字段需要保留的机器可读证据码。 */
  code?: string;
}

/** prep 规则 producer 的统一通货；消费者只能经 evidence/merge 的字段策略裁决。 */
export type RuleFactClaim<T = unknown> = Omit<
  FactClaim<
    T,
    RuleFactFieldPath,
    Extract<CandidateFactProducer, 'rule' | 'system'>,
    RuleFactEvidence
  >,
  'operation'
> & {
  operation: 'set' | 'clear';
  confidence: RuleFactConfidence;
  /** clear 仅用于规则轨条件清除时声明允许清掉的旧值；value 本身仍保持 null。 */
  clearValues?: readonly unknown[];
};

export interface RuleFactClaims {
  readonly claims: readonly RuleFactClaim[];
  readonly reasoning: string;
}

// ==================== 动作授权 verdicts ====================

/** booking 姓名/手机号动作闸门的统一裁决结果。 */
export interface NameGateVerdict {
  decision: 'allow' | 'reject_collect';
  reason?: string;
}

/** 单条 claim 的裁决结论。 */
export type CandidateClaimDecision = 'accepted' | 'rejected' | 'superseded' | 'needs_confirmation';

/**
 * 拒绝/待确认原因（观测 rejectionReason 的机器可读枚举）。
 *
 * 只允许**出处/形态**类原因——每条都能由确定性代码全封闭判定（字符串比对、长度、
 * 查表）。2026-08-12 删除 `no_candidate_evidence` / `value_not_derivable` /
 * `strict_field_free_derivation`：那是"正则推不出你这个值所以你错了"的语义否决，
 * 宪法 P11 判定确定性代码在裁决点无此权力，删除即不可表达。判据见 ./notary.ts。
 */
export type CandidateClaimRejectionReason =
  | 'quote_not_found' // quote 在候选人可作证语料中找不到（含严格身份字段的值未逐字落在 quote 内）
  | 'quote_too_short' // quote 短于该字段的最小语境长度（C5 短引文门）
  | 'quote_echoes_agent_message' // quote 同时存在于 Agent 已发消息全集（C4 回声）→ 转确认
  | 'invalid_value_shape' // 值形状非法（年龄越界、占位号、纯数字姓名、称谓后缀等）
  | 'conflicting_evidence' // 同字段多条有效证据值不一致 → 转确认（C2，不再互杀）
  | 'stale_after_correction'; // 已被更新的 correct/clear 取代

export interface AdjudicatedClaim<T = unknown> {
  claim: CandidateFactClaim<T>;
  decision: CandidateClaimDecision;
  rejectionReason?: CandidateClaimRejectionReason;
  /** superseded 时指向取代它的 claimId。 */
  supersededByClaimId?: string;
}

// ==================== 模型入参 schema（precheck candidateClaims） ====================

/**
 * 模型经 precheck `candidateClaims` 提交的声明。刻意窄于内部 Claim：
 * producer/assertedAt/claimId 由工具侧统一填充，模型只提交它的理解与出处。
 */
export const CandidateClaimInputSchema = z.object({
  field: z.enum(CANDIDATE_CLAIM_FIELDS).describe('字段名'),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.null()])
    .describe('字段值；operation=clear 时传 null'),
  operation: z.enum(CANDIDATE_FACT_OPERATIONS).optional().describe('操作语义，默认 set'),
  quote: z
    .string()
    .min(1)
    .max(200)
    .describe('候选人原话逐字片段——必须能在候选人消息里原样找到，否则该声明无效'),
  agentQuestionQuote: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe('operation=confirm 时绑定的 Agent 求证问句逐字片段；值本体必须出现在该问句中'),
  reasoning: z.string().max(300).optional().describe('该值如何从原话得出（归一化/纠错说明）'),
});

export type CandidateClaimInput = z.infer<typeof CandidateClaimInputSchema>;
