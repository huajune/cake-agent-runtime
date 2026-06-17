import { formatExtractionFactLines } from '@memory/formatters/fact-lines.formatter';
import {
  FALLBACK_EXTRACTION,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

function highConfidence<T>(value: T, evidence: string): HighConfidenceValue<T> {
  return { value, confidence: 'high', source: 'rule', evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    },
    preferences: {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: 'test',
  };
}

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
        city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        district: ['杨浦区'],
      },
    });

    expect(lines).toEqual([
      '- 姓名: 张三',
      '- 联系方式: 13800138000',
      '- 年龄: 25',
      '- 是否学生: 否',
      '- 意向品牌: 来伊份、奥乐齐',
      '- 意向城市: 上海（置信度: high）',
      '- 意向区域: 杨浦区',
    ]);
  });

  it('should skip empty fields', () => {
    expect(formatExtractionFactLines(FALLBACK_EXTRACTION)).toEqual([]);
  });

  it('should render Boss title brand ids', () => {
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      preferences: {
        ...FALLBACK_EXTRACTION.preferences,
        brand_ids: [10239],
      },
    });

    expect(lines).toEqual(['- 意向品牌ID: 10239']);
  });

  it('should render high-confidence field metadata without evidence by default', () => {
    const facts: HighConfidenceFacts = {
      ...emptyHighConfidenceFacts(),
      interview_info: {
        ...emptyHighConfidenceFacts().interview_info,
        age: highConfidence('24', '年龄识别：24'),
      },
    };
    const lines = formatExtractionFactLines(facts);

    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule）']);
  });

  it('should render evidence only when includeEvidence is set (extraction prompt path)', () => {
    const facts: HighConfidenceFacts = {
      ...emptyHighConfidenceFacts(),
      interview_info: {
        ...emptyHighConfidenceFacts().interview_info,
        age: highConfidence('24', '年龄识别：24'),
      },
    };
    const lines = formatExtractionFactLines(facts, { includeEvidence: true });

    expect(lines).toEqual(['- 年龄: 24（置信度: high，来源: rule，证据: 年龄识别：24）']);
  });

  it('should warn when a time-sensitive fact is stale (extractedAt > 24h ago)', () => {
    const staleAt = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const lines = formatExtractionFactLines({
      ...FALLBACK_EXTRACTION,
      interview_info: {
        ...FALLBACK_EXTRACTION.interview_info,
        interview_time: {
          value: '明天下午2点',
          confidence: 'medium',
          source: 'llm',
          evidence: 'LLM 结构化提取',
          extractedAt: staleAt,
        },
      },
    } as unknown as Parameters<typeof formatExtractionFactLines>[0]);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('- 面试时间: 明天下午2点');
    expect(lines[0]).toContain('可能已失效');
  });
});
