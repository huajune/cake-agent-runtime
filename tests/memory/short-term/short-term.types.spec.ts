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

  it('city 只收事实信封：裸字符串 / CityFact 对象与非域内 source 均校验失败', () => {
    const base = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '测试基线',
    });
    const withCity = (city: unknown) =>
      SessionFactsSchema.safeParse({ ...base, preferences: { ...base.preferences, city } });

    expect(withCity('上海市').success).toBe(false);
    expect(
      withCity({ value: '上海', confidence: 'medium', evidence: 'explicit_city' }).success,
    ).toBe(false);
    expect(
      withCity({ value: '上海', confidence: 'medium', source: 'llm', evidence: 'x' }).success,
    ).toBe(false);

    const envelope = withCity({
      value: '上海',
      confidence: 'medium',
      source: 'rule',
      evidence: 'explicit_city',
    });
    expect(envelope.success).toBe(true);
    if (envelope.success) {
      expect(envelope.data.preferences.city).toEqual({
        value: '上海',
        confidence: 'medium',
        source: 'rule',
        evidence: 'explicit_city',
      });
    }
  });
});
