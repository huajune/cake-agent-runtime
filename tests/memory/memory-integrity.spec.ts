import { cleanMemoryFacts, isValidSummaryEntry } from '@memory/memory-integrity';
import { isExpiredTemporalFact } from '@memory/temporal-facts';
import { compactCandidatePool } from '@memory/short-term/candidate-pool';

const now = new Date('2026-10-23T16:00:00Z'); // 上海 10-24 00:00
const fact = (value: unknown, updatedAt = '2026-09-01T00:00:00Z') => ({
  value,
  updatedAt,
  evidence: '原话',
  confidence: 'medium',
  source: 'candidate_quote',
});
describe('memory integrity boundaries', () => {
  it('业务日期当天有效，过期日期失效，无效日期不猜', () => {
    expect(isExpiredTemporalFact('available_after', fact({ date: '2026-10-23' }), now)).toBe(true);
    expect(isExpiredTemporalFact('available_after', fact({ date: '2026-10-24' }), now)).toBe(false);
    expect(isExpiredTemporalFact('available_after', fact({ date: '2026-02-31' }), now)).toBe(false);
    expect(isExpiredTemporalFact('available_after', fact({ date: '明天' }), now)).toBe(false);
  });
  it('无明确日期的推迟 30 天失效，明确未来日期不因旧时间失效', () => {
    expect(isExpiredTemporalFact('delayed_intent', fact({ until: '以后' }), now)).toBe(true);
    expect(isExpiredTemporalFact('delayed_intent', fact({ until: '2026-12-01' }), now)).toBe(false);
    expect(isExpiredTemporalFact('delayed_intent', { value: { until: '以后' } }, now)).toBe(false);
  });
  it('清洗保留时间、出处、合法体重和显式墓碑，重复执行不变', () => {
    const input = {
      has_health_certificate: fact('无但接受办理健康证'),
      age: fact('年龄不详'),
      weight: fact('100'),
      education: fact('中专'),
      available_after: fact({ date: '2026-10-01', raw: '十月开始' }),
      brands: fact(null),
      salary: { ...fact('6000'), evidence: '😀'.repeat(201) },
    };
    const cleaned = cleanMemoryFacts(input, now)!;
    expect(cleaned.has_health_certificate).toEqual({
      ...input.has_health_certificate,
      value: '无本地有效健康证，接受办理',
    });
    expect(cleaned.age).toBeNull();
    expect(cleaned.weight).toEqual(input.weight);
    expect(cleaned.available_after).toEqual({ ...input.available_after, value: null });
    expect(cleaned.brands).toEqual(input.brands);
    expect(cleanMemoryFacts(cleaned, now)).toEqual(cleaned);
  });
  it('摘要必须有有效会话标识和时间范围', () => {
    const valid = {
      sessionId: 'chat',
      summary: '候选人找兼职',
      startTime: '2026-10-01',
      endTime: '2026-10-02',
    };
    expect(isValidSummaryEntry(valid)).toBe(true);
    for (const invalid of [
      { ...valid, sessionId: '' },
      { ...valid, summary: '' },
      { ...valid, endTime: 'broken' },
      { ...valid, startTime: '2026-10-03' },
    ])
      expect(isValidSummaryEntry(invalid)).toBe(false);
  });
  it('岗位池前十保留详情，后续保留资格和出处，最多三十条', () => {
    const jobs = Array.from({ length: 35 }, (_, i) => ({
      jobId: i + 1,
      brandName: '品牌',
      jobName: '店员',
      storeName: '门店',
      storeAddress: '地址',
      salaryDesc: '详细薪资'.repeat(200),
      regionName: null,
      jobCategoryName: null,
      ageRequirement: '18-35',
      healthCertificateRequirement: 'before_interview',
      cityName: '上海',
      laborForm: '兼职',
    }));
    const result = compactCandidatePool(jobs);
    expect(result).toHaveLength(30);
    expect(result[0].salaryDesc).toBe(jobs[0].salaryDesc);
    expect(result[10]).toMatchObject({
      jobId: 11,
      ageRequirement: '18-35',
      healthCertificateRequirement: 'before_interview',
      salaryDesc: null,
    });
    expect(JSON.stringify(result).length).toBeLessThan(
      JSON.stringify(jobs.slice(0, 30)).length / 2,
    );
  });
});
