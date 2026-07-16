import type {
  GuardrailRepairMode,
  GuardrailRiskLevel,
  GuardViolation,
  OutputDecision,
} from '@shared-types/guardrail.contract';

/** 出站守卫单次审查的全文详情（首审必有；二审仅 repaired 时存在）。 */
export interface GuardrailReviewStepDetail {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  ruleIds: string[];
  blockedRuleIds: string[];
  /** 违规意见全文（type/evidence/suggestion/severity...），紧凑摘要里被裁掉的部分。 */
  violations: GuardViolation[];
  /** feedbackToGenerator 聚合文本，即注入重写 prompt 的违规反馈。 */
  feedback?: string;
}

export type GuardrailSemanticReviewMode = 'shadow' | 'enforce' | 'confidence_downgraded';

export interface GuardrailSemanticFinding {
  code: string;
  evidenceQuote: string;
  userImpact: string;
  feedbackToGenerator: string;
}

/** 语义守卫的一次完整裁决；同一 trace 可包含首审、修复后二审等多次记录。 */
export interface GuardrailSemanticReview {
  mode: GuardrailSemanticReviewMode;
  decision: OutputDecision;
  confidence: string;
  findings: GuardrailSemanticFinding[];
  draftReply: string;
  reviewedAt?: string;
}

export interface GuardrailSemanticReviewInput extends Omit<GuardrailSemanticReview, 'reviewedAt'> {
  traceId: string;
  chatId?: string;
  userId?: string;
  botUserName?: string;
  contactName?: string;
  userMessage?: string;
}

/** 一条出站守卫审查档案（写入/读取共用形状，camelCase）。 */
export interface GuardrailReviewRecord {
  traceId: string;
  chatId?: string;
  userId?: string;
  botImId?: string;
  botUserName?: string;
  contactName?: string;
  userMessage?: string;
  /** 首版回复全文（触发 revise/replan 时被丢弃重写的那一版）。 */
  firstReply: string;
  first: GuardrailReviewStepDetail;
  repairMode?: GuardrailRepairMode;
  repaired: boolean;
  /** 受控修复后的重写版全文；repaired=false 时为 undefined。 */
  revisedReply?: string;
  revised?: GuardrailReviewStepDetail;
  /** 重写时注入的既成副作用提示。 */
  committedSideEffects?: string;
  finalDecision: OutputDecision;
  reasonCode?: string;
  /** Semantic Reviewer 的完整判例序列；包含 shadow 与 enforce 首审/二审。 */
  semanticReviews: GuardrailSemanticReview[];
  createdAt?: string;
}

type GuardrailReviewInsertBase = Omit<
  GuardrailReviewRecord,
  'createdAt' | 'semanticReviews' | 'repairMode' | 'repaired' | 'revisedReply' | 'revised'
>;

export type GuardrailReviewInsertInput =
  | (GuardrailReviewInsertBase & {
      repaired: false;
      repairMode?: undefined;
      revisedReply?: undefined;
      revised?: undefined;
    })
  | (GuardrailReviewInsertBase & {
      repaired: true;
      repairMode: GuardrailRepairMode;
      revisedReply: string;
      revised: GuardrailReviewStepDetail;
    });

export type GuardrailReviewWriteOutcome = 'inserted' | 'duplicate' | 'failed';
