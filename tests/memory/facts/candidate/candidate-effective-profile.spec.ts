import {
  buildEffectiveProfile,
  pickAcceptedValues,
} from '@memory/facts/candidate/candidate-effective-profile';
import type { AdjudicatedClaim } from '@memory/facts/candidate/candidate-fact-claim.types';

const NOW = new Date('2026-08-05T10:00:00+08:00');

function accepted(field: 'name' | 'phone' | 'age', value: string | number, claimId = `c_${field}`): AdjudicatedClaim {
  return {
    decision: 'accepted',
    claim: {
      claimId,
      field,
      value,
      operation: 'set',
      producer: 'rule',
      interpretation: 'direct',
      evidence: { quote: String(value) },
      assertedAt: NOW.toISOString(),
    },
  };
}

describe('buildEffectiveProfile 四态视图', () => {
  it('accepted claim 优先于会话基线与画像线索', () => {
    const profile = buildEffectiveProfile({
      adjudicated: [accepted('name', '王玥')],
      sessionAccepted: { name: { value: '旧名' } },
      profileHints: { name: '更旧名' },
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(profile.fields.name).toMatchObject({ value: '王玥', status: 'accepted', source: 'rule' });
  });

  it('clear 使字段 missing 且屏蔽画像线索复活', () => {
    const clearEntry: AdjudicatedClaim = {
      decision: 'accepted',
      claim: {
        claimId: 'c_clear',
        field: 'phone',
        value: null,
        operation: 'clear',
        producer: 'model',
        interpretation: 'direct',
        evidence: { quote: '别用之前那个号' },
        assertedAt: NOW.toISOString(),
      },
    };
    const profile = buildEffectiveProfile({
      adjudicated: [clearEntry],
      sessionAccepted: {},
      profileHints: { phone: '13800000001' },
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(profile.fields.phone).toMatchObject({ value: null, status: 'missing' });
  });

  it('无 claim 字段：会话基线 accepted、画像线索 historical_unconfirmed', () => {
    const profile = buildEffectiveProfile({
      adjudicated: [],
      sessionAccepted: { name: { value: '王玥', evidence: '会话事实' } },
      profileHints: { age: 25 },
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(profile.fields.name).toMatchObject({ status: 'accepted', source: 'session' });
    expect(profile.fields.age).toMatchObject({ status: 'historical_unconfirmed', source: 'profile' });
  });

  it('conflicting_evidence 的字段标 conflicted', () => {
    const conflicted: AdjudicatedClaim = {
      ...accepted('age', 24),
      decision: 'rejected',
      rejectionReason: 'conflicting_evidence',
    };
    const profile = buildEffectiveProfile({
      adjudicated: [conflicted],
      sessionAccepted: {},
      profileHints: {},
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(profile.fields.age?.status).toBe('conflicted');
  });

  it('pickAcceptedValues 只取 accepted 且非空的字段', () => {
    const profile = buildEffectiveProfile({
      adjudicated: [accepted('name', '王玥')],
      sessionAccepted: {},
      profileHints: { age: 25 },
      messageWatermark: 'w',
      factsVersion: 1,
      now: NOW,
    });
    expect(pickAcceptedValues(profile)).toEqual({ name: '王玥' });
  });
});
