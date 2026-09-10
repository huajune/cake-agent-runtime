import {
  guardrailInputDisplay,
  guardrailOutcomeDisplay,
} from '../../web/src/components/GuardrailTrace/outcome';

describe('guardrail outcome display', () => {
  it('labels a handoff as an intent, without claiming dispatch success', () => {
    expect(guardrailOutcomeDisplay({ finalOutcome: 'handoff' })).toMatchObject({
      kind: 'handoff',
      label: '转人工意图',
    });
  });

  it('keeps old block distinct from intentional silence and does not infer handoff', () => {
    expect(guardrailOutcomeDisplay({ finalDecision: 'block' })).toMatchObject({
      kind: 'legacy_block',
      label: '历史拦截／未发送',
    });
    expect(guardrailOutcomeDisplay({ legacyFinalDecision: 'block' })).toMatchObject({
      kind: 'legacy_block',
    });
    expect(
      guardrailOutcomeDisplay({ finalDecision: 'block', reasonCode: 'meta_narration_silenced' }),
    ).toMatchObject({ kind: 'skipped', label: '有意静默' });
    expect(
      guardrailOutcomeDisplay({
        finalDecision: 'block',
        reasonCode: 'meta_narration_silenced|override:meta_narration_reply:repair',
      }),
    ).toMatchObject({ kind: 'skipped' });
  });

  it('shows review-only advice if no final resolution exists or the view is advisory', () => {
    expect(guardrailOutcomeDisplay({ reasonCode: 'rule_hit' })).toMatchObject({ kind: 'advisory' });
    expect(guardrailOutcomeDisplay({ finalOutcome: 'handoff' }, true)).toMatchObject({
      kind: 'advisory',
    });
    expect(guardrailOutcomeDisplay({ finalDecision: 'block' }, true)).toMatchObject({
      kind: 'advisory',
    });
  });

  it('preserves legacy reply outcomes and prefers explicit current resolutions', () => {
    expect(guardrailOutcomeDisplay({ finalDecision: 'observe' })).toMatchObject({ kind: 'reply' });
    expect(
      guardrailOutcomeDisplay({ finalOutcome: 'skipped', finalDecision: 'pass' }),
    ).toMatchObject({ kind: 'skipped' });
  });
});

describe('inbound guardrail display compatibility', () => {
  it('distinguishes new handoff intent from historical block without claiming dispatch', () => {
    expect(guardrailInputDisplay('handoff')).toMatchObject({
      kind: 'handoff',
      label: '入站转人工意图',
    });
    expect(guardrailInputDisplay('block')).toMatchObject({
      kind: 'legacy_block',
      label: '历史入站拦截／未发送',
    });
    expect(guardrailInputDisplay('pass')).toMatchObject({ kind: 'pass', label: '预检通过' });
  });
});
