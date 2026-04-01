import { extractHighConfidenceFacts } from '@memory/services/high-confidence-facts';

describe('extractHighConfidenceFacts', () => {
  const brandData = [
    { name: '来伊份', aliases: ['来一份', '来1份'] },
    { name: '肯德基', aliases: ['KFC'] },
  ];

  it('should normalize brand aliases from user messages', () => {
    const result = extractHighConfidenceFacts(['来一份'], brandData);

    expect(result?.preferences.brands).toEqual(['来伊份']);
  });

  it('should not misclassify generic phrases as brands', () => {
    const result = extractHighConfidenceFacts(['给我来一份工作'], brandData);

    expect(result).toBeNull();
  });

  it('should extract explicit high-confidence entities from one sentence', () => {
    const result = extractHighConfidenceFacts(
      ['上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空'],
      brandData,
    );

    expect(result?.preferences.city).toBe('上海');
    expect(result?.preferences.district).toEqual(['杨浦']);
    expect(result?.preferences.labor_form).toBe('兼职');
    expect(result?.preferences.position).toEqual(['服务员']);
    expect(result?.preferences.schedule).toBe('周末');
    expect(result?.interview_info.gender).toBe('男');
    expect(result?.interview_info.age).toBe('25');
    expect(result?.interview_info.has_health_certificate).toBe('有');
  });
});
