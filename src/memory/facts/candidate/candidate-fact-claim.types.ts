import { z } from 'zod';

/**
 * 候选人事实声明（CandidateFactClaim）——候选人资料证据化方案 §4.1 的落地类型。
 *
 * 设计定位：模型、规则提取器和确认解析器不再各自输出裸值，而是输出统一的
 * "有出处的主张"：值 + 操作语义 + 生产者 + 解释方式 + 候选人原话证据。
 * 裁决器（candidate-fact-adjudicator）对 claim 做确定性验证后才允许其进入
 * 报名链路（precheck checklist / booking payload）。
 *
 * 与 HC-2（CollectedField/provenance 白名单）的关系：本类型是 HC-2 骨架的升级
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
export type CandidateFactOperation = 'set' | 'correct' | 'confirm' | 'clear';

/**
 * 解释方式：
 * - direct：原话直接给出（"我叫王玥"）；
 * - normalized：确定性归一化（"一米六三"→163）；
 * - context_confirmation：绑定确认问句的应答（"对"确认的是被问字段）；
 * - derived：由其他字段确定性推导（预留，当前字段策略均不放行自由推导）。
 */
export type CandidateFactInterpretation =
  | 'direct'
  | 'normalized'
  | 'context_confirmation'
  | 'derived';

/**
 * 生产者：
 * - rule：确定性规则解析（candidate-field-parser / identity-statement）；
 * - model：模型工具入参（显式 candidateClaims 或旧裸字段转译的 legacy claim）；
 * - confirmation_resolver：确认问答解析器；
 * - human：真人经理带外裁决（P1 human_oob 的 Claim 化预留，当前无写入方）。
 */
export type CandidateClaimProducer = 'rule' | 'model' | 'confirmation_resolver' | 'human';

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

export interface CandidateFactClaim<T = unknown> {
  /** 会话内唯一：`{producer}_{field}_{序号}`，由 producer 统一生成。 */
  claimId: string;
  field: CandidateClaimField;
  /** clear 操作时为 null。 */
  value: T | null;
  operation: CandidateFactOperation;
  producer: CandidateClaimProducer;
  interpretation: CandidateFactInterpretation;
  evidence: CandidateFactEvidence;
  /** 生产者附注（模型 claim 的推理说明等），仅审计用。 */
  reasoning?: string;
  /** ISO8601。 */
  assertedAt: string;
}

/** 单条 claim 的裁决结论。 */
export type CandidateClaimDecision = 'accepted' | 'rejected' | 'superseded' | 'needs_confirmation';

/** 拒绝/待确认原因（观测 rejectionReason 的机器可读枚举）。 */
export type CandidateClaimRejectionReason =
  | 'quote_not_found' // quote 在候选人原文中找不到
  | 'no_candidate_evidence' // legacy 裸值在候选人全文中推导不出等价值
  | 'value_not_derivable' // quote 存在但按字段策略推导不出所声明的值
  | 'strict_field_free_derivation' // 严格身份字段出现自由推导
  | 'invalid_value_shape' // 值形状非法（年龄越界等）
  | 'conflicting_evidence' // 同字段多条有效证据值不一致
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
  operation: z
    .enum(['set', 'correct', 'confirm', 'clear'])
    .optional()
    .describe('操作语义，默认 set'),
  quote: z
    .string()
    .min(1)
    .max(200)
    .describe('候选人原话逐字片段——必须能在候选人消息里原样找到，否则该声明无效'),
  reasoning: z.string().max(300).optional().describe('该值如何从原话得出（归一化/纠错说明）'),
});

export type CandidateClaimInput = z.infer<typeof CandidateClaimInputSchema>;
