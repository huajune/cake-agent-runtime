import { containsSensitiveScreeningText } from '@tools/utils/sensitive-screening.util';

describe('sensitive-screening util', () => {
  it('detects direct mentions of household/native-place/ethnicity keywords', () => {
    expect(containsSensitiveScreeningText('要求本地户籍')).toBe(true);
    expect(containsSensitiveScreeningText('需提供户口本')).toBe(true);
    expect(containsSensitiveScreeningText('籍贯不限，但要稳定')).toBe(true);
    expect(containsSensitiveScreeningText('少数民族需备注')).toBe(true);
    expect(containsSensitiveScreeningText('只招本地人')).toBe(true);
    expect(containsSensitiveScreeningText('外地人勿扰')).toBe(true);
  });

  it('detects exclusion phrasing with region/ethnicity suffix', () => {
    expect(containsSensitiveScreeningText('不要新疆西藏籍')).toBe(true);
    expect(containsSensitiveScreeningText('谢绝东三省籍候选人')).toBe(true);
    expect(containsSensitiveScreeningText('不接受少数民族')).toBe(true);
    expect(containsSensitiveScreeningText('仅限上海籍')).toBe(true);
    expect(containsSensitiveScreeningText('限汉族')).toBe(true);
  });

  it('does not flag ordinary job text', () => {
    expect(containsSensitiveScreeningText('18-45岁，有健康证优先，排班灵活')).toBe(false);
    expect(containsSensitiveScreeningText('需要长期稳定，能上晚班')).toBe(false);
    expect(containsSensitiveScreeningText('不要迟到早退')).toBe(false);
    expect(containsSensitiveScreeningText(null)).toBe(false);
    expect(containsSensitiveScreeningText('')).toBe(false);
  });
});
