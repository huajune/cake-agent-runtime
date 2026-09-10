import {
  readGuardrailTrace,
  readGuardViolations,
  readOutputOutcome,
} from '@biz/message/repositories/guardrail-review-read.util';
import type { GuardViolation } from '@shared-types/guardrail.contract';

describe('guardrail historical read boundary', () => {
  it('reads old JSONB review steps without deriving a handoff from old block', () => {
    const value = readGuardrailTrace({
      steps: [
        { stage: 'first', decision: 'revise' },
        { stage: 'revised', decision: 'block' },
      ],
      repaired: true,
      finalDecision: 'block',
      reasonCode: 'repair_exhausted',
    });
    expect(value?.steps.map((step) => step.decision)).toEqual(['repair', 'repair']);
    expect(value?.finalOutcome).toBeUndefined();
    expect(value?.legacyFinalDecision).toBe('block');
  });

  it('recognizes the historical meta narration silence and legacy pass/observe', () => {
    expect(readOutputOutcome('block', 'meta_narration_silenced')).toBe('skipped');
    expect(
      readGuardrailTrace({
        steps: [],
        repaired: false,
        finalDecision: 'block',
        reasonCode: 'meta_narration_silenced|override:meta_narration_reply:repair',
      }),
    ).toMatchObject({ finalOutcome: 'skipped' });
    expect(readOutputOutcome('pass')).toBe('reply');
    expect(readOutputOutcome('observe')).toBe('reply');
    expect(readOutputOutcome('repair')).toBeUndefined();
    expect(readOutputOutcome('handoff')).toBe('handoff');
  });

  it('does not invent a final outcome for a current advisory review', () => {
    expect(
      readGuardrailTrace({ steps: [{ stage: 'first', decision: 'repair' }], repaired: false })
        ?.finalOutcome,
    ).toBeUndefined();
  });

  it('reads historical recoverability only at the boundary and prefers the new explicit flag', () => {
    const old = [
      { type: 'leak', recoverability: 'non_recoverable' },
      { type: 'tone', recoverability: 'recoverable' },
      { type: 'changed', recoverability: 'recoverable', allowFailOpen: false },
    ] as unknown as GuardViolation[];
    expect(readGuardViolations(old)).toEqual([
      { type: 'leak', allowFailOpen: false },
      { type: 'tone', allowFailOpen: true },
      { type: 'changed', allowFailOpen: false },
    ]);
  });
});
