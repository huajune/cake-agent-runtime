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

/** 字段值进入候选人档案前的来源标记。 */
export type CandidateFieldProvenance =
  | 'user_text'
  | 'booking_writeback'
  | 'llm_extract'
  | 'model_arg';

/** 已收集字段的值、出处与时间信封。 */
export interface CandidateCollectedField<T = string | number> {
  value: T;
  provenance: CandidateFieldProvenance;
  evidence?: string;
  at: number;
}

/** 可直接作为权威档案事实的来源白名单。 */
export const AUTHORITATIVE_PROVENANCE: ReadonlySet<CandidateFieldProvenance> = new Set([
  'user_text',
  'booking_writeback',
]);
