import {
  extractPresentedJobs,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from '@memory/services/session-job-matching';
import { RecommendedJobSummary } from '@memory/types/session-facts.types';

describe('session-job-matching', () => {
  const chaoneiJob: RecommendedJobSummary = {
    jobId: 526626,
    brandName: '必胜客',
    jobName: '服务员',
    storeName: '朝内店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '20元/小时',
    jobCategoryName: '餐饮/中餐/普通服务员',
  };

  const dongdanJob: RecommendedJobSummary = {
    jobId: 526627,
    brandName: '必胜客',
    jobName: '服务员',
    storeName: '东单店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '20元/小时',
    jobCategoryName: '餐饮/中餐/普通服务员',
  };

  const retailJob: RecommendedJobSummary = {
    jobId: 526628,
    brandName: '全家',
    jobName: '门店岗位',
    storeName: '建国门店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '18元/小时',
    jobCategoryName: '零售/便利店/店员',
  };

  it('should extract presented jobs from assistant reply', () => {
    expect(
      extractPresentedJobs('离你最近的是朝内店，东单店也可以。', [chaoneiJob, dongdanJob]),
    ).toEqual([chaoneiJob, dongdanJob]);
  });

  it('should resolve focus job when user explicitly picks a store', () => {
    expect(resolveCurrentFocusJob('我选朝内店', [chaoneiJob, dongdanJob], [], [])).toEqual(
      chaoneiJob,
    );
  });

  it('should clear focus job when user asks to switch batch', () => {
    expect(resolveCurrentFocusJob('再看看别的', [chaoneiJob], [], [])).toBeNull();
  });

  it('should keep original focus when no clear signal is found', () => {
    expect(resolveCurrentFocusJob('我再想想', [chaoneiJob, dongdanJob], [], [])).toBeUndefined();
  });

  it('should select the only presented job when focus intent is generic', () => {
    expect(resolveCurrentFocusJob('就这家吧', [chaoneiJob], [], [])).toEqual(chaoneiJob);
  });

  it('should match hierarchical jobCategoryName segments when user describes a role', () => {
    expect(resolveCurrentFocusJob('我想去零售店员那个岗位', [], [], [chaoneiJob, retailJob])).toEqual(
      retailJob,
    );
  });

  it('should derive focus job from assistant template when one job is clearly dominant', () => {
    const jiangwanDailyJob: RecommendedJobSummary = {
      jobId: 527487,
      brandName: '肯德基',
      jobName: '肯德基-江湾字节T4-日结-小时工',
      storeName: '江湾字节T4',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '兼职',
      salaryDesc: '24元/小时',
      jobCategoryName: '日结小时工',
    };

    const jiangwanHybridJob: RecommendedJobSummary = {
      jobId: 527488,
      brandName: '肯德基',
      jobName: '肯德基-江湾字节T4-兼职+-全职',
      storeName: '江湾字节T4',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '兼职',
      salaryDesc: '17元/小时起',
      jobCategoryName: '兼职+全职',
    };

    const youfangDailyJob: RecommendedJobSummary = {
      jobId: 527489,
      brandName: '肯德基',
      jobName: '肯德基-杨浦悠方-日结-小时工',
      storeName: '杨浦悠方',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '兼职',
      salaryDesc: '24元/小时',
      jobCategoryName: '日结小时工',
    };

    const assistantTemplate =
      '面试要求：先将以下资料补充下发给我，我来帮你约面试 姓名： 联系方式： 性别： 年龄： 面试时间： 应聘门店：江湾字节T4 应聘岗位：肯德基-江湾字节T4-日结-小时工';

    expect(
      resolveAssistantAnchoredFocusJob(
        assistantTemplate,
        [jiangwanDailyJob, jiangwanHybridJob],
        [],
        [jiangwanDailyJob, jiangwanHybridJob, youfangDailyJob],
      ),
    ).toEqual(jiangwanDailyJob);
  });
});
