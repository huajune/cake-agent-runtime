import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import { FALLBACK_EXTRACTION } from '@memory/types/session-facts.types';

describe('formatExtractionFactLines', () => {
  it('should render known interview and preference fields in stable labels', () => {
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        name: '张三',
        phone: '13800138000',
        age: '25',
        is_student: false,
      },
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        brands: ['来伊份', '奥乐齐'],
        city: '上海',
        district: ['杨浦区'],
      },
    });

    expect(lines).toEqual([
      '- 姓名: 张三',
      '- 联系方式: 13800138000',
      '- 年龄: 25',
      '- 是否学生: 否',
      '- 意向品牌: 来伊份、奥乐齐',
      '- 意向城市: 上海',
      '- 意向区域: 杨浦区',
    ]);
  });

  it('should skip empty fields', () => {
    expect(formatExtractionFactLines(FALLBACK_EXTRACTION)).toEqual([]);
  });
});
