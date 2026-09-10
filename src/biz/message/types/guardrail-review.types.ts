import type {
  GuardrailRepairMode,
  GuardrailRiskLevel,
  GuardViolation,
  OutputDecision,
  OutputResolution,
} from '@shared-types/guardrail.contract';

/** 出站守卫单次真实审查的全文详情（首审必有；修复后可能未进入二审）。 */
export interface GuardrailReviewStepDetail {
  decision: OutputDecision;
  riskLevel: GuardrailRiskLevel;
  ruleIds: string[];
  blockedRuleIds: string[];
  /** 违规意见全文（type/evidence/suggestion/severity...），紧凑摘要里被裁掉的部分。 */
  violations: GuardViolation[];
  /** 汇总给受控修复的违规反馈，不表示重新调用 Generator。 */
  feedback?: string;
}

export type GuardrailSemanticReviewMode = 'shadow' | 'enforce' | 'confidence_downgraded';

export interface GuardrailSemanticFinding {
  code: string;
  evidenceQuote: string;
  userImpact: string;
  feedbackToGenerator: string;
}

/** 升级前语义守卫留下的历史裁决，只用于读取已有档案。 */
export interface GuardrailSemanticReview {
  mode: GuardrailSemanticReviewMode;
  decision: OutputDecision;
  confidence: string;
  findings: GuardrailSemanticFinding[];
  draftReply: string;
  reviewedAt?: string;
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
  /** 首审对应的回复全文；是否采用由 Runner 最终处置决定。 */
  firstReply: string;
  first: GuardrailReviewStepDetail;
  repairMode?: GuardrailRepairMode;
  repaired: boolean;
  /** 受控修复后的重写版全文；repaired=false 时为 undefined。 */
  revisedReply?: string;
  revised?: GuardrailReviewStepDetail;
  /** 重写时注入的既成副作用提示。 */
  committedSideEffects?: string;
  finalOutcome?: OutputResolution['outcome'];
  /** 历史 block 只能确认未发送，无法回溯证明是否介入。只在读取旧档案时提供。 */
  legacyFinalDecision?: 'block';
  reasonCode?: string;
  /** 升级前 Semantic Reviewer 的历史判例；当前链路不再写入。 */
  semanticReviews: GuardrailSemanticReview[];
  createdAt?: string;
}

type GuardrailReviewInsertBase = Omit<
  GuardrailReviewRecord,
  | 'createdAt'
  | 'semanticReviews'
  | 'repairMode'
  | 'repaired'
  | 'revisedReply'
  | 'revised'
  | 'finalOutcome'
  | 'legacyFinalDecision'
> & { finalOutcome: OutputResolution['outcome'] };

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
      revisedReply?: string;
      revised?: GuardrailReviewStepDetail;
    });

export type GuardrailReviewWriteOutcome = 'inserted' | 'duplicate' | 'failed';
