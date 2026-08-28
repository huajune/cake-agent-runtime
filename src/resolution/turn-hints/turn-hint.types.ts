import type { CandidateFactProducer } from '@resolution/candidate/types';

/** rule-track 仍会产出的完整字段路径；路径本身消除 interview/preferences 同名歧义。 */
export const TURN_HINT_FIELD_PATHS = [
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

export type TurnHintFieldPath = (typeof TURN_HINT_FIELD_PATHS)[number];
export type TurnHintConfidence = 'high' | 'medium' | 'low';

export interface TurnHintEvidence {
  quote: string;
  label: string;
  code?: string;
  messageIndex?: number;
}

/**
 * 仅在当前回合有效的可撤销线索。它可以辅助 prompt、检索与工具动作，不能直接写表单。
 */
export interface TurnHint<T = unknown> {
  claimId: string;
  field: TurnHintFieldPath;
  value: T | null;
  operation: 'set' | 'clear';
  producer: Extract<CandidateFactProducer, 'candidate_quote' | 'rule' | 'system'>;
  interpretation: 'direct' | 'normalized' | 'context_confirmation' | 'derived';
  evidence: TurnHintEvidence;
  reasoning?: string;
  assertedAt: string;
  confidence: TurnHintConfidence;
  /** clear 只声明允许清掉的旧值；value 仍保持 null。 */
  clearValues?: readonly unknown[];
}

export interface TurnHints {
  readonly claims: readonly TurnHint[];
  readonly reasoning: string;
}
