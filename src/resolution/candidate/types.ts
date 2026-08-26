import type { CandidateFactProducer } from '@resolution/evidence/claim.types';

/** 回合账本与会话档案共同使用的候选人字段键。 */
export type CandidateFieldKey =
  | 'name'
  | 'phone'
  | 'age'
  | 'gender'
  | 'education'
  | 'healthCert'
  | 'householdProvince'
  | 'height'
  | 'weight'
  | 'supplementAnswers';

/** 确定性解析器的统一返回信封：标准值与支持该值的候选人原文片段。 */
export interface CandidateParseResult<T> {
  value: T;
  excerpt: string;
}

/** 已收集字段的值、出处与时间信封。 */
export interface CandidateCollectedField<T = string | number> {
  value: T;
  producer: CandidateFactProducer;
  evidence?: string;
  at: number;
}

/**
 * 不足以自动确权、但允许在收资表单中“带值求证”的候选人字段提示。
 *
 * 这不是 accepted fact，**三禁令**：消费者只能把它渲染成「值（如有误请改）」；
 * 不得据此拒绝候选人、不得据此提交报名、不得把来源升级成 candidate。
 *
 * 2026-08-12 从性别推广到全字段：约束力在三禁令本身，不在字段数量。
 */
export interface CandidatePrefillHint {
  value: string;
  reason: 'system_source' | 'medium_confidence';
}

/** 可带值求证的字段集：与 checklist 收资字段同构，supplementAnswers 不参与。 */
export type CandidatePrefillField = Exclude<CandidateFieldKey, 'supplementAnswers'>;

export type CandidatePrefillHints = Partial<Record<CandidatePrefillField, CandidatePrefillHint>>;

/**
 * 允许作为候选人字段持久化出处的 producer 白名单。
 *
 * 置信度是证据的属性，不是产者的属性，因此规则解析器不能直接确权。
 * 其产物只作提示便签和形态校验，统一走 CandidatePrefillHint。
 */
export const PERSISTABLE_CANDIDATE_FIELD_PRODUCERS: ReadonlySet<CandidateFactProducer> = new Set([
  'candidate_quote',
  'system',
]);
