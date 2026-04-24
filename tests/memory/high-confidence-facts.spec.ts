import { extractHighConfidenceFacts } from '@memory/facts/high-confidence-facts';

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

    expect(result?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      evidence: 'municipality_compact',
    });
    expect(result?.preferences.district).toEqual(['杨浦']);
    // 平台全为兼职岗位，"兼职"不作为 labor_form 提取（无筛选价值）。
    expect(result?.preferences.labor_form).toBeNull();
    expect(result?.preferences.position).toEqual(['服务员']);
    expect(result?.preferences.schedule).toBe('周末');
    expect(result?.interview_info.gender).toBe('男');
    expect(result?.interview_info.age).toBe('25');
    expect(result?.interview_info.has_health_certificate).toBe('有');
  });

  it('should extract specific labor_form subtypes only (小时工 / 寒假工 / 暑假工 / 兼职+)', () => {
    const hourly = extractHighConfidenceFacts(['我想做小时工'], brandData);
    expect(hourly?.preferences.labor_form).toBe('小时工');

    const winter = extractHighConfidenceFacts(['寒假想找寒假工'], brandData);
    expect(winter?.preferences.labor_form).toBe('寒假工');

    // "兼职"/"全职"/"临时工" 都不是合法的 labor_form 取值。
    // 单独一条 "我要找兼职" 没有任何可提取字段，整体返回 null。
    expect(extractHighConfidenceFacts(['我要找兼职'], brandData)).toBeNull();
    expect(extractHighConfidenceFacts(['我找全职'], brandData)).toBeNull();

    // 即便伴随其他信号（能触发非 null 结果），也不应把"兼职"写进 labor_form
    const combined = extractHighConfidenceFacts(['想找兼职服务员'], brandData);
    expect(combined?.preferences.position).toEqual(['服务员']);
    expect(combined?.preferences.labor_form).toBeNull();
  });
});
