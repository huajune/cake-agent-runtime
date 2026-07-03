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
  createdAt?: string;
}

type GuardrailReviewInsertBase = Omit<
  GuardrailReviewRecord,
  'createdAt' | 'repairMode' | 'repaired' | 'revisedReply' | 'revised'
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
