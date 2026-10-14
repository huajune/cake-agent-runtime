import { formatSalarySummary } from '@tools/job-list/brand-stores.util';
import { renderCandidateCard } from '@tools/job-list/candidate-card.util';
import { mapJobsToRecommendedSummaries } from '@tools/job-list/job-summary.util';
import { resolveSalaryHeadline } from '@tools/job-list/salary-display.util';
import type { JobDetail } from '@sponge/sponge.types';

function makeJob(laborForm: string | undefined, salaryScenarioList: unknown[]): JobDetail {
  return {
    basicInfo: {
      jobId: 1,
      brandName: '测试品牌',
      jobName: '服务员',
      jobNickName: '服务员',
      laborForm,
      storeInfo: { storeName: '测试门店' },
    },
    jobSalary: { salaryScenarioList },
    hiringRequirement: {
      basicPersonalRequirements: { minAge: 18, maxAge: 45, genderRequirement: '不限' },
    },
  } as unknown as JobDetail;
}

const PART_TIME_DUAL = {
  salaryType: '正式',
  basicSalary: { basicSalary: 25.5, basicSalaryUnit: '元/时' },
  comprehensiveSalary: {
    minComprehensiveSalary: 3000,
    maxComprehensiveSalary: 4000,
    comprehensiveSalaryUnit: '元/月',
  },
};

const STAIRS = {
  hasStairSalary: '有阶梯',
  stairSalaries: [
    { fullWorkTime: 60, fullWorkTimeUnit: '累计工作小时', salary: 27.5, salaryUnit: '元/时' },
  ],
};

const FIXTURES: Array<{ name: string; job: JobDetail; headline: string; cardPrefix: string }> = [
  {
    name: '兼职双栏（基础时薪 + 综合月薪）→ 时薪',
    job: makeJob('兼职', [PART_TIME_DUAL]),
    headline: '25.5元/时',
    cardPrefix: '',
  },
  {
    name: '兼职有阶梯 → 基础时薪，卡片冠"基础"',
    job: makeJob('兼职', [{ ...PART_TIME_DUAL, ...STAIRS }]),
    headline: '25.5元/时',
    cardPrefix: '基础',
  },
  {
    name: '兼职只有综合区间 → 综合区间',
    job: makeJob('兼职', [
      {
        comprehensiveSalary: {
          minComprehensiveSalary: 22,
          maxComprehensiveSalary: 26,
          comprehensiveSalaryUnit: '元/时',
        },
      },
    ]),
    headline: '22-26元/时',
    cardPrefix: '',
  },
  {
    name: '全职双栏 → 综合月薪，卡片冠"综合薪资"',
    job: makeJob('全职', [
      {
        basicSalary: { basicSalary: 5500, basicSalaryUnit: '元/月' },
        comprehensiveSalary: {
          minComprehensiveSalary: 6000,
          maxComprehensiveSalary: 7000,
          comprehensiveSalaryUnit: '元/月',
        },
      },
    ]),
    headline: '6000-7000元/月',
    cardPrefix: '综合薪资',
  },
  {
    name: '用工形式缺失 → 综合优先、不加前缀',
    job: makeJob(undefined, [PART_TIME_DUAL]),
    headline: '3000-4000元/月',
    cardPrefix: '',
  },
  {
    name: '培训期方案排在前面 → 只取正式方案（摘要曾取第一条）',
    job: makeJob('兼职', [
      { salaryType: '培训期', basicSalary: { basicSalary: 20, basicSalaryUnit: '元/时' } },
      PART_TIME_DUAL,
    ]),
    headline: '25.5元/时',
    cardPrefix: '',
  },
  {
    name: '单位缺失 → 只写"元"（卡片曾补 元/月、摘要曾补 元，两边分叉）',
    job: makeJob('兼职', [{ basicSalary: { basicSalary: 19 } }]),
    headline: '19元',
    cardPrefix: '',
  },
];

function cardSalaryText(job: JobDetail): string {
  const line = renderCandidateCard(job)
    ?.multiLine.split('\n')
    .find((item) => item.trim().startsWith('薪资：'));
  return line?.trim().replace(/^薪资：/u, '') ?? '';
}

describe('salary-display.util（推荐卡片 / 摘要行 / 会话记忆的薪资主数唯一来源）', () => {
  it.each(FIXTURES)('$name', ({ job, headline, cardPrefix }) => {
    expect(resolveSalaryHeadline(job)?.text).toBe(headline);
    // 卡片薪资行与摘要行、会话记忆 salaryDesc 用同一个主数，只差卡片前缀
    expect(cardSalaryText(job).startsWith(`${cardPrefix}${headline}`)).toBe(true);
    expect(formatSalarySummary(job)).toBe(headline);
    expect(mapJobsToRecommendedSummaries([job])[0].salaryDesc).toBe(headline);
  });

  it('兼职岗主数取自基础薪资，全职岗取自综合薪资', () => {
    expect(resolveSalaryHeadline(makeJob('兼职', [PART_TIME_DUAL]))).toEqual({
      text: '25.5元/时',
      source: 'basic',
      laborForm: '兼职',
    });
    expect(resolveSalaryHeadline(makeJob('全职', [PART_TIME_DUAL]))).toEqual({
      text: '3000-4000元/月',
      source: 'comprehensive',
      laborForm: '全职',
    });
  });

  it('没有任何方案金额时主数为空，摘要才退回试工期薪资', () => {
    const job = {
      basicInfo: { laborForm: '兼职' },
      jobSalary: { salaryScenarioList: [], probationSalary: { salary: 20, salaryUnit: '元/时' } },
    };
    expect(resolveSalaryHeadline(job)).toBeNull();
    expect(formatSalarySummary(job)).toBe('20元/时（试工期）');
  });
});
