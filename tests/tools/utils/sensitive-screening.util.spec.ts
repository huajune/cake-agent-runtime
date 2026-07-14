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

  it('detects major-based screening conditions', () => {
    // badcase 2026-07-06：肯德基筛选题 label 原文
    expect(containsSensitiveScreeningText('专业（非新媒、食品）')).toBe(true);
    expect(containsSensitiveScreeningText('专业(非新媒体相关)')).toBe(true);
    expect(containsSensitiveScreeningText('不招新媒体或食品相关专业')).toBe(true);
    expect(containsSensitiveScreeningText('非食品类专业')).toBe(true);
    expect(containsSensitiveScreeningText('专业要求：非新媒体')).toBe(true);
    expect(containsSensitiveScreeningText('所学专业需说明')).toBe(true);
  });

  it('detects marriage and childbearing screening conditions', () => {
    expect(containsSensitiveScreeningText('婚育要求：已婚已育')).toBe(true);
    expect(containsSensitiveScreeningText('婚姻状况：未婚')).toBe(true);
    expect(containsSensitiveScreeningText('仅限已育人员')).toBe(true);
    expect(containsSensitiveScreeningText('备孕中暂不考虑')).toBe(true);
    expect(containsSensitiveScreeningText('已结婚且有孩子')).toBe(true);
  });

  it('does not flag ordinary job text', () => {
    expect(containsSensitiveScreeningText('18-45岁，有健康证优先，排班灵活')).toBe(false);
    expect(containsSensitiveScreeningText('需要长期稳定，能上晚班')).toBe(false);
    expect(containsSensitiveScreeningText('不要迟到早退')).toBe(false);
    // "专业"的形容词用法不算筛选条件
    expect(containsSensitiveScreeningText('提供专业培训，专业的带教团队')).toBe(false);
    expect(containsSensitiveScreeningText('团队非常专业，氛围好')).toBe(false);
    // "非"字打头的良性备注不应连带"专业"形容词误报（2026-07-06 review）
    expect(containsSensitiveScreeningText('非全日制排班 专业带教')).toBe(false);
    expect(containsSensitiveScreeningText('非工作日也有专业培训')).toBe(false);
    expect(containsSensitiveScreeningText('非高峰时段有专业指导')).toBe(false);
    expect(containsSensitiveScreeningText(null)).toBe(false);
    expect(containsSensitiveScreeningText('')).toBe(false);
  });
});
