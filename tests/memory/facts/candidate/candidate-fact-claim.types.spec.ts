import {
  CANDIDATE_CLAIM_FIELDS,
  CandidateClaimInputSchema,
  isCandidateClaimField,
} from '@memory/facts/candidate/candidate-fact-claim.types';

describe('candidate-fact-claim.types', () => {
  it('十字段清单与守卫函数一致', () => {
    expect(CANDIDATE_CLAIM_FIELDS).toHaveLength(10);
    for (const field of CANDIDATE_CLAIM_FIELDS) {
      expect(isCandidateClaimField(field)).toBe(true);
    }
    expect(isCandidateClaimField('interviewTime')).toBe(false);
    expect(isCandidateClaimField('city')).toBe(false);
  });

  it('CandidateClaimInputSchema：quote 必填非空、operation 可缺省', () => {
    expect(
      CandidateClaimInputSchema.safeParse({ field: 'height', value: 163, quote: '我一米六三' }).success,
    ).toBe(true);
    expect(CandidateClaimInputSchema.safeParse({ field: 'height', value: 163, quote: '' }).success).toBe(
      false,
    );
    expect(CandidateClaimInputSchema.safeParse({ field: 'height', value: 163 }).success).toBe(false);
  });

  it('CandidateClaimInputSchema：clear 允许 value 为 null；未知字段拒绝', () => {
    expect(
      CandidateClaimInputSchema.safeParse({
        field: 'phone',
        value: null,
        operation: 'clear',
        quote: '别用之前那个号',
      }).success,
    ).toBe(true);
    expect(
      CandidateClaimInputSchema.safeParse({ field: 'salary', value: '20', quote: '20一小时' }).success,
    ).toBe(false);
  });
});
