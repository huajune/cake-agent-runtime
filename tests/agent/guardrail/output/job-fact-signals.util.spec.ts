import { QUANTIFIED_JOB_FACT_PATTERN } from '@/agent/guardrail/output/job-fact-signals.util';

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
    ])('识别%s', (_label, text) => {
      expect(QUANTIFIED_JOB_FACT_PATTERN.test(text)).toBe(true);
    });

    it.each([
      ['只有门店名', '推荐静安寺店'],
      ['模糊薪资', '薪资面议'],
      ['只有月份', '下个月可以入职'],
      ['发薪日不属于结构行判据', '每月 15 号发薪'],
    ])('不把%s识别为结构化岗位硬事实', (_label, text) => {
      expect(QUANTIFIED_JOB_FACT_PATTERN.test(text)).toBe(false);
    });
  });
});
