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

/** 已收集字段的值、出处与时间信封。 */
export interface CandidateCollectedField<T = string | number> {
  value: T;
  producer: CandidateFactProducer;
  evidence?: string;
  at: number;
}

/** 可直接作为权威档案事实的来源白名单。 */
export const AUTHORITATIVE_PRODUCERS: ReadonlySet<CandidateFactProducer> = new Set([
  'candidate_quote',
  'rule',
  'system',
]);
