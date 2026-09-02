import {
  FALLBACK_EXTRACTION,
  SessionFactsSchema,
  toSessionFacts,
} from '@memory/short-term/short-term.types';

describe('SessionFactsSchema 读写边界', () => {
  it('空字符串信封归 null：旧提取路径曾把 value:"" 连信封落库（09-02 核对 3 例籍贯）', () => {
    const base = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '测试基线',
    });
    const parsed = SessionFactsSchema.parse({
      ...base,
      interview_info: {
        ...base.interview_info,
        household_register_province: {
          value: '   ',
          confidence: 'medium',
          source: 'model',
          evidence: 'LLM 结构化提取',
        },
        name: {
          value: '张三',
          confidence: 'high',
          source: 'candidate_quote',
          evidence: '姓名：张三',
        },
      },
    });
    expect(parsed.interview_info.household_register_province).toBeNull();
    expect(parsed.interview_info.name?.value).toBe('张三');
  });
});
