import { notarizeResumeFields } from '@resolution/candidate/resume-fields';
import { buildResumeFactSheet } from '@tools/resume/resume-sheet.util';

describe('resume-sheet.util', () => {
  it('builds a non-degraded resume sheet with candidate-owned whitelisted phone only', () => {
    const text = '姓名：兮兮\n电话：18271421690\n期望城市：上海';
    const extraction = notarizeResumeFields(
      [
        { field: 'name', value: '兮兮', sourceText: '姓名：兮兮' },
        { field: 'phone', value: '18271421690', sourceText: '电话：18271421690' },
        { field: 'expectedCity', value: '上海', sourceText: '期望城市：上海' },
      ],
      text,
    );

    expect(buildResumeFactSheet(extraction, text)).toEqual({
      kind: 'resume',
      fields: [{ key: 'phone', value: '18271421690', ownership: 'candidate' }],
      rawDescription: text,
      degraded: false,
    });
  });

  it('keeps a resume sheet valid when no whitelisted field was extracted', () => {
    const text = '姓名：兮兮';
    const extraction = notarizeResumeFields(
      [{ field: 'name', value: '兮兮', sourceText: text }],
      text,
    );
    expect(buildResumeFactSheet(extraction, text)).toMatchObject({
      kind: 'resume',
      fields: [],
      degraded: false,
    });
  });
});
