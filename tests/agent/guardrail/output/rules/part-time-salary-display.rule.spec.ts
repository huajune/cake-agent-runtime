import { detectPartTimeSalaryDisplayMismatch } from '@agent/guardrail/output/rules/part-time-salary-display.rule';
import type { RecommendedJobSummary } from '@resolution/job/types';

/**
 * 生产 trace batch_6ab4b2cdce406a6aee874892_1790233240971（2026-09-24）：兼职岗塔克贝尔值班经理
 * 被介绍成「月薪3000-4000，时薪25.5起」。2026-10-14 用户裁定：兼职岗即使候选人问月收入，也只按
 * 时薪与阶梯说明，不报综合月薪。observe 入场。
 */
describe('part_time_salary_display_mismatch（兼职岗按月薪介绍）', () => {
  const partTimeJob: RecommendedJobSummary = {
    jobId: 530001,
    brandName: '塔克贝尔',
    jobName: '值班经理',
    storeName: '徐汇店',
    cityName: '上海市',
    regionName: '徐汇区',
    laborForm: '兼职',
    salaryDesc: '25.5元/时',
    jobCategoryName: '餐饮/值班经理',
  };
  const fullTimeJob: RecommendedJobSummary = {
    jobId: 530002,
    brandName: '奥乐齐',
    jobName: '通岗店员',
    storeName: '庆春银泰',
    cityName: '杭州市',
    regionName: '上城区',
    laborForm: '全职',
    salaryDesc: '5000-7000元/月',
    jobCategoryName: '零售/通岗店员',
  };

  it('生产原样：兼职时薪岗被报成月薪区间 → observe 命中', () => {
    const hit = detectPartTimeSalaryDisplayMismatch(
      '还有一个塔克贝尔值班经理，月薪3000-4000，时薪25.5起，做满一定小时数还能升档。',
      { sessionJobs: [partTimeJob] },
    );
    expect(hit?.ruleId).toBe('part_time_salary_display_mismatch');
    expect(hit?.action).toBe('observe');
    expect(hit?.currentReplySendable).toBe(true);
    expect(hit?.label).toContain('塔克贝尔 值班经理');
    expect(hit?.label).toContain('月薪3000-4000');
    expect(hit?.label).toContain('25.5元/时');
  });

  it('回复没点名岗位（追问"一个月多少"）时按入口焦点岗位绑定', () => {
    expect(
      detectPartTimeSalaryDisplayMismatch('做满的话一个月能拿3000-4000元/月左右', {
        sessionJobs: [partTimeJob, fullTimeJob],
        focusJobId: partTimeJob.jobId,
      })?.ruleId,
    ).toBe('part_time_salary_display_mismatch');
  });

  it('本轮查岗召回的兼职岗同样适用', () => {
    expect(
      detectPartTimeSalaryDisplayMismatch('塔克贝尔值班经理（徐汇店）月薪3000-4000', {
        turnJobs: [partTimeJob],
      })?.ruleId,
    ).toBe('part_time_salary_display_mismatch');
  });

  it('全职岗按综合月薪介绍不判', () => {
    expect(
      detectPartTimeSalaryDisplayMismatch('奥乐齐庆春银泰的通岗店员，综合薪资5000-7000元/月', {
        sessionJobs: [fullTimeJob],
      }),
    ).toBeNull();
  });

  it('兼职岗按时薪与阶梯说明不判', () => {
    expect(
      detectPartTimeSalaryDisplayMismatch(
        '塔克贝尔值班经理是按小时算的，时薪25.5元，做满一定小时数升档，不按月薪算',
        { sessionJobs: [partTimeJob] },
      ),
    ).toBeNull();
  });

  it('多岗混排时月薪是同回复里全职岗自己的薪资 → 不判', () => {
    expect(
      detectPartTimeSalaryDisplayMismatch(
        '1. 塔克贝尔值班经理（徐汇店），25.5元/时\n2. 奥乐齐通岗店员（庆春银泰），5000-7000元/月',
        { sessionJobs: [partTimeJob, fullTimeJob] },
      ),
    ).toBeNull();
  });

  it('兼职岗标准展示本就是月薪（只有综合月薪区间）或认不出绑定岗位 → 不判', () => {
    const monthlyPartTime = { ...partTimeJob, salaryDesc: '3000-4000元/月' };
    expect(
      detectPartTimeSalaryDisplayMismatch('塔克贝尔值班经理月薪3000-4000', {
        sessionJobs: [monthlyPartTime],
      }),
    ).toBeNull();
    expect(detectPartTimeSalaryDisplayMismatch('月薪3000-4000', {})).toBeNull();
  });
});
