import type { IdentityEvidence } from '@resolution/candidate/student-identity';
import {
  buildIdentitySupplementAnswerBackfills,
  isIdentityStatusSupplementLabel,
} from '@tools/duliday/precheck/supplement-overlap.util';

describe('supplement-overlap.util', () => {
  const identityEvidence: IdentityEvidence = {
    identity: '社会人士',
    source: 'choice_answer',
    evidence: '社会人士',
    messageIndex: 2,
  };

  it.each(['学信网学籍状态', '学信网在籍情况', '是否是学信网在籍学生', '在籍状态'])(
    'recognizes identity/status overlap label: %s',
    (labelName) => {
      expect(isIdentityStatusSupplementLabel(labelName)).toBe(true);
    },
  );

  it('does not classify unrelated student screening copy as an overlap', () => {
    expect(isIdentityStatusSupplementLabel('不要学生')).toBe(false);
    expect(isIdentityStatusSupplementLabel('毕业证')).toBe(false);
  });

  it('copies the candidate identity quote verbatim without semantic conversion', () => {
    expect(
      buildIdentitySupplementAnswerBackfills({
        labelNames: ['学信网学籍状态'],
        identityEvidence,
      }),
    ).toEqual({ 学信网学籍状态: '社会人士' });
  });

  it('keeps an explicitly provided supplement answer', () => {
    expect(
      buildIdentitySupplementAnswerBackfills({
        labelNames: ['学信网学籍状态'],
        identityEvidence,
        providedAnswers: { 学信网学籍状态: '候选人明确填写：不在籍' },
      }),
    ).toEqual({ 学信网学籍状态: '候选人明确填写：不在籍' });
  });
});
