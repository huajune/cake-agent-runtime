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
 * 这不是 accepted fact：消费者只能把它渲染成「值（如有误请改）」；不得据此
 * 拒绝候选人、提交报名，或把来源升级成 candidate。当前仅开放性别一个字段，
 * 避免把整份 medium/system 画像重新变成工具侧的第二事实仓。
 */
export interface CandidatePrefillHint {
  value: string;
  reason: 'system_source' | 'medium_confidence';
}

export interface CandidatePrefillHints {
  gender?: CandidatePrefillHint;
}

/** 可直接作为权威档案事实的来源白名单。 */
export const AUTHORITATIVE_PRODUCERS: ReadonlySet<CandidateFactProducer> = new Set([
  'candidate_quote',
  'rule',
  'system',
]);
