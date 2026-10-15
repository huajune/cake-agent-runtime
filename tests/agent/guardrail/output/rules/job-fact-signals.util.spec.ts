import {
  extractQuantifiedJobFacts,
  isMonthlySalaryFact,
  isSalaryFact,
  normalizeQuantifiedJobFact,
  QUANTIFIED_JOB_FACT_PATTERN,
} from '@/agent/guardrail/output/rules/job-fact-signals.util';

describe('job-fact-signals.util', () => {
  describe('QUANTIFIED_JOB_FACT_PATTERN', () => {
    it.each([
      ['距离（公里）', '门店离你大约 0.5 公里'],
      ['距离（小写 km）', '距离约 2.8km'],
      ['距离（大写 KM）', '距离约 3 KM'],
      ['小时薪资', '薪资 24 元/小时'],
      ['日薪', '日薪 180元/天'],
      ['月薪', '综合 6000 元/月'],
      ['半角班次', '班次 09:30-18:00'],
      ['全角班次', '班次 9：30至18：00'],
      ['单位前置月薪区间', '月薪3000-4000'],
      ['单位前置时薪带起', '时薪25.5起'],
      ['单位前置底薪', '底薪 4500 元'],
      ['单位前置日薪', '日薪大概200'],
    ])('识别%s', (_label, text) => {
      expect(QUANTIFIED_JOB_FACT_PATTERN.test(text)).toBe(true);
    });

    it.each([
      ['只有门店名', '推荐静安寺店'],
      ['模糊薪资', '薪资面议'],
      ['只有月份', '下个月可以入职'],
      ['发薪日不属于结构行判据', '每月 15 号发薪'],
      ['问月薪不带数字', '月薪多少呀'],
    ])('不把%s识别为结构化岗位硬事实', (_label, text) => {
      expect(QUANTIFIED_JOB_FACT_PATTERN.test(text)).toBe(false);
    });
  });

  describe('normalizeQuantifiedJobFact（单位前置与后缀写法同一规范形）', () => {
    it.each([
      ['月薪3000-4000', '3000-4000元/月'],
      ['月薪 3000 到 4000 元', '3000-4000元/月'],
      ['3000-4000 元/月', '3000-4000元/月'],
      ['时薪25.5', '25.5元/时'],
      ['25.5 元/小时', '25.5元/时'],
      ['日薪180元/天', '180元/天'],
      ['底薪25元/时', '25元/时'],
    ])('%s → %s', (raw, normalized) => {
      expect(normalizeQuantifiedJobFact(raw)).toBe(normalized);
    });

    it('抽取全部事实并区分薪资/月薪', () => {
      const facts = extractQuantifiedJobFacts('月薪3000-4000，时薪25.5起，离你2.3km');
      expect(facts.map((fact) => fact.normalized)).toEqual([
        '3000-4000元/月',
        '25.5元/时',
        '2.3km',
      ]);
      expect(facts.map((fact) => isSalaryFact(fact.normalized))).toEqual([true, true, false]);
      expect(facts.map((fact) => isMonthlySalaryFact(fact.normalized))).toEqual([
        true,
        false,
        false,
      ]);
    });
  });
});
