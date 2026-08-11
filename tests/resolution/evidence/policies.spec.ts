import { CANDIDATE_FIELD_RISK, validateClaimValueAgainstQuote } from '@resolution/evidence/policies';
import type { CandidateFactClaim } from '@resolution/evidence/claim.types';

const NOW = new Date('2026-08-05T10:00:00+08:00');

function claim(partial: Partial<CandidateFactClaim> & Pick<CandidateFactClaim, 'field' | 'value'>): CandidateFactClaim {
  return {
    claimId: 't1',
    operation: 'set',
    producer: 'model',
    interpretation: 'direct',
    evidence: { quote: '' },
    assertedAt: NOW.toISOString(),
    ...partial,
  } as CandidateFactClaim;
}

describe('candidate-fact-policy 字段风险三分级', () => {
  it('风险表覆盖全部十字段', () => {
    expect(Object.keys(CANDIDATE_FIELD_RISK)).toHaveLength(10);
    expect(CANDIDATE_FIELD_RISK.name).toBe('strict_identity');
    expect(CANDIDATE_FIELD_RISK.phone).toBe('strict_identity');
    expect(CANDIDATE_FIELD_RISK.isStudent).toBe('boolean_identity');
    expect(CANDIDATE_FIELD_RISK.height).toBe('normalizable');
  });

  it('strict：quote 逐字含值通过；不含判自由推导', () => {
    expect(
      validateClaimValueAgainstQuote(claim({ field: 'name', value: '王玥', evidence: { quote: '我叫王玥' } }), NOW),
    ).toBeNull();
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'name', value: '王玥', evidence: { quote: '用之前登记的名字' } }),
        NOW,
      ),
    ).toMatchObject({ reason: 'strict_field_free_derivation' });
  });

  it('strict phone：忽略分隔符比对', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'phone', value: '13900000002', evidence: { quote: '139 0000 0002' } }),
        NOW,
      ),
    ).toBeNull();
  });

  it('normalizable：quote 推导等价通过；不等价拒', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'height', value: 163, interpretation: 'normalized', evidence: { quote: '我一米六三' } }),
        NOW,
      ),
    ).toBeNull();
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'height', value: 180, evidence: { quote: '我一米六三' } }),
        NOW,
      ),
    ).toMatchObject({ reason: 'value_not_derivable' });
  });

  it('clear 操作免值验证', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'phone', value: null, operation: 'clear', evidence: { quote: '别用那个号了' } }),
        NOW,
      ),
    ).toBeNull();
  });

  it('值形状非法直接拒（整句当年龄）', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'age', value: '晚上才可以，有吗？', evidence: { quote: '晚上才可以，有吗？' } }),
        NOW,
      ),
    ).toMatchObject({ reason: 'invalid_value_shape' });
  });

  it('boolean_identity：识别器产出（非 model）豁免词典复核，"是的"类纯应答不被误拒', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({
          field: 'isStudent',
          value: false,
          producer: 'confirmation_resolver',
          interpretation: 'context_confirmation',
          evidence: { quote: '是的' },
        }),
        NOW,
      ),
    ).toBeNull();
  });

  it('boolean_identity：model 产出仍走词典复核，"是的"推不出身份被拒', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({ field: 'isStudent', value: false, producer: 'model', evidence: { quote: '是的' } }),
        NOW,
      ),
    ).toMatchObject({ reason: 'value_not_derivable' });
  });

  it('context_confirmation（非身份字段）以 agentQuestionQuote 为验证基准', () => {
    expect(
      validateClaimValueAgainstQuote(
        claim({
          field: 'age',
          value: 24,
          interpretation: 'context_confirmation',
          evidence: { quote: '对', agentQuestionQuote: '你是24岁对吧' },
        }),
        NOW,
      ),
    ).toBeNull();
  });
});
