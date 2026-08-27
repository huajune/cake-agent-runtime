import { CANDIDATE_CLAIM_FIELDS, isCandidateClaimField } from '@resolution/evidence/claim.types';

describe('candidate-fact-claim.types', () => {
  it('十字段清单与守卫函数一致', () => {
    expect(CANDIDATE_CLAIM_FIELDS).toHaveLength(10);
    for (const field of CANDIDATE_CLAIM_FIELDS) {
      expect(isCandidateClaimField(field)).toBe(true);
    }
    expect(isCandidateClaimField('interviewTime')).toBe(false);
    expect(isCandidateClaimField('city')).toBe(false);
  });
});
