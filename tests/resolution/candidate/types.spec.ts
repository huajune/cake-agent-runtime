import { CANDIDATE_FACT_FIELDS, isCandidateFactField } from '@resolution/candidate/types';

describe('candidate fact fields', () => {
  it('十字段清单与守卫函数一致', () => {
    expect(CANDIDATE_FACT_FIELDS).toHaveLength(10);
    for (const field of CANDIDATE_FACT_FIELDS) {
      expect(isCandidateFactField(field)).toBe(true);
    }
    expect(isCandidateFactField('interviewTime')).toBe(false);
    expect(isCandidateFactField('city')).toBe(false);
  });
});
