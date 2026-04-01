import {
  extractPresentedJobs,
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
    jobCategoryName: '餐饮',
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
    jobCategoryName: '餐饮',
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
});
