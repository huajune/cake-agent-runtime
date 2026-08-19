import { parseEducation, parseHighestEducation } from '@resolution/candidate/education';

describe('parseHighestEducation', () => {
  it('returns the highest level by keyword-table order instead of first text position', () => {
    expect(parseHighestEducation('高中毕业\n工作后取得本科学历\n后续读研究生')).toEqual({
      value: '硕士',
      excerpt: '研究生',
    });
  });

  it('allows school and college context that the chat parser intentionally rejects', () => {
    const resumeText = '教育经历：测试职业学院，大专';
    expect(parseEducation(resumeText)).toBeNull();
    expect(parseHighestEducation(resumeText)).toEqual({ value: '大专', excerpt: '大专' });
  });

  it.each([
    ['博士研究生', '博士'],
    ['硕士研究生', '硕士'],
    ['大学本科', '本科'],
    ['高职院校', '高职'],
    ['职高', '中专技校职高'],
    ['初中', '初中'],
    ['小学', '初中以下'],
  ])('normalizes %s to %s', (text, value) => {
    expect(parseHighestEducation(text)?.value).toBe(value);
  });

  it('returns null when no education level is present', () => {
    expect(parseHighestEducation('有餐饮门店工作经验')).toBeNull();
  });
});
