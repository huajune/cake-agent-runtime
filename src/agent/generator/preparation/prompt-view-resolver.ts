import type {
  EntityExtractionResult,
  Preferences,
  SessionFacts,
} from '@memory/short-term/short-term.types';
import { unwrapSessionFacts } from '@memory/short-term/short-term.types';
import type { SessionBrandState } from '@resolution/brand/brand-resolution.types';
import { isValidLaborForm, type LaborFormIntentDecision } from '@resolution/labor-form';
import { projectTurnHints, resolveTurnHints } from '@resolution/turn-hints/reducer';
import type { TurnHintFieldPath, TurnHints } from '@resolution/turn-hints/turn-hint.types';
import type { HardConstraintsPromptView, TurnHintsPromptView } from '../context/prompt-model.types';

/** 把共享 TurnHints 裁决结果投影成 Section 可直接渲染的两档视图。 */
export function resolveTurnHintsPromptView(input: {
  displayTurnHints: TurnHints | null;
  pendingFields: readonly TurnHintFieldPath[];
  currentTurnTexts: readonly string[];
}): TurnHintsPromptView {
  const pending = new Set(input.pendingFields);
  const currentFields = new Set<TurnHintFieldPath>();
  for (const fact of resolveTurnHints(input.displayTurnHints)) {
    if (!pending.has(fact.field)) currentFields.add(fact.field);
  }
  return {
    current: selectClaims(input.displayTurnHints, currentFields),
    pendingConfirmation: selectClaims(input.displayTurnHints, pending),
    currentTurnTexts: input.currentTurnTexts,
  };
}

/** 合并会话事实与本轮高置信规则事实；同一份结果同时约束 Prompt 与工具模型。 */
export function resolveHardConstraintsPromptView(input: {
  sessionFacts: SessionFacts | null;
  turnHints: TurnHints | null;
  laborFormIntent: LaborFormIntentDecision;
  brandState: SessionBrandState | null;
}): HardConstraintsPromptView {
  const trusted = unwrapSessionFacts(input.sessionFacts, { minConfidence: 'high' });
  const current = projectTurnHints(input.turnHints, { minConfidence: 'high' });
  const hasFacts = Boolean(trusted || current || input.laborFormIntent.kind === 'set');
  if (!hasFacts) return { facts: null, brandState: input.brandState };

  const interview: EntityExtractionResult['interview_info'] = {
    ...emptyInterviewInfo(),
    ...dropNulls(trusted?.interview_info),
    ...dropNulls(current?.interview_info),
  };
  const previousLaborForm =
    current?.preferences.labor_form ?? trusted?.preferences.labor_form ?? null;
  const activeLaborForm =
    input.laborFormIntent.kind === 'set'
      ? input.laborFormIntent.value
      : input.laborFormIntent.kind === 'clear' &&
          isValidLaborForm(previousLaborForm) &&
          input.laborFormIntent.clearedValues.some((value) => value === previousLaborForm)
        ? null
        : previousLaborForm;

  const preferences: Preferences = {
    brand_ids: current?.preferences.brand_ids ?? trusted?.preferences.brand_ids ?? null,
    salary: current?.preferences.salary ?? trusted?.preferences.salary ?? null,
    position: current?.preferences.position ?? trusted?.preferences.position ?? null,
    schedule: current?.preferences.schedule ?? trusted?.preferences.schedule ?? null,
    city: current?.preferences.city ?? trusted?.preferences.city ?? null,
    district: current?.preferences.district ?? trusted?.preferences.district ?? null,
    location: current?.preferences.location ?? trusted?.preferences.location ?? null,
    labor_form: activeLaborForm,
    delayed_intent:
      current?.preferences.delayed_intent ?? trusted?.preferences.delayed_intent ?? null,
    short_term: current?.preferences.short_term ?? trusted?.preferences.short_term ?? null,
    open_position: current?.preferences.open_position ?? trusted?.preferences.open_position ?? null,
    time_windows: current?.preferences.time_windows ?? trusted?.preferences.time_windows ?? null,
    schedule_constraint:
      current?.preferences.schedule_constraint ?? trusted?.preferences.schedule_constraint ?? null,
    available_after:
      current?.preferences.available_after ?? trusted?.preferences.available_after ?? null,
  };

  return { facts: { interview, preferences }, brandState: input.brandState };
}

function selectClaims(
  hints: TurnHints | null,
  fields: ReadonlySet<TurnHintFieldPath>,
): TurnHints | null {
  if (!hints) return null;
  const claims = hints.claims.filter((claim) => fields.has(claim.field));
  return claims.length > 0 ? { claims, reasoning: hints.reasoning } : null;
}

function dropNulls(
  obj: EntityExtractionResult['interview_info'] | undefined,
): Partial<EntityExtractionResult['interview_info']> {
  if (!obj) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    result[key] = value;
  }
  return result as Partial<EntityExtractionResult['interview_info']>;
}

function emptyInterviewInfo(): EntityExtractionResult['interview_info'] {
  return {
    name: null,
    phone: null,
    gender: null,
    age: null,
    is_student: null,
    education: null,
    has_health_certificate: null,
    upload_resume: null,
  };
}
