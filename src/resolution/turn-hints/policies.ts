import type { TurnHintFieldPath } from './turn-hint.types';

export type TurnHintSelection = 'first-scalar' | 'last-scalar' | 'union-array' | 'composite';

export interface TurnHintFieldPolicy {
  selection: TurnHintSelection;
  allowedOperations: readonly ('set' | 'clear')[];
  /** composite 投影的固定形状；producer 的 null 不参与覆盖，但消费者仍看到完整对象。 */
  defaults?: Readonly<Record<string, unknown>>;
}

/**
 * rule-track 的逐字段归并参数。producer 只发 claim，不得依据这些语义自行吞并；
 * first/last/union/composite 全部在 turn-hints/reducer 的同一条提示流上执行。
 */
export const TURN_HINT_FIELD_POLICIES = {
  'interview_info.name': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.phone': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.gender': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.gender_source': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.age': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.is_student': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.education': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.has_health_certificate': {
    selection: 'last-scalar',
    allowedOperations: ['set'],
  },
  'interview_info.experience': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.upload_resume': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.height': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.weight': { selection: 'first-scalar', allowedOperations: ['set'] },
  'interview_info.household_register_province': {
    selection: 'first-scalar',
    allowedOperations: ['set'],
  },
  'preferences.salary': { selection: 'first-scalar', allowedOperations: ['set'] },
  'preferences.position': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.schedule': { selection: 'first-scalar', allowedOperations: ['set'] },
  'preferences.city': { selection: 'last-scalar', allowedOperations: ['set', 'clear'] },
  'preferences.district': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.location': { selection: 'union-array', allowedOperations: ['set', 'clear'] },
  'preferences.labor_form': { selection: 'last-scalar', allowedOperations: ['set', 'clear'] },
  'preferences.schedule_constraint': {
    selection: 'composite',
    allowedOperations: ['set', 'clear'],
    defaults: {
      onlyWeekends: null,
      onlyEvenings: null,
      onlyMornings: null,
      maxDaysPerWeek: null,
    },
  },
  'preferences.available_after': {
    selection: 'last-scalar',
    allowedOperations: ['set', 'clear'],
  },
} as const satisfies Record<TurnHintFieldPath, TurnHintFieldPolicy>;
