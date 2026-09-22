import { Logger } from '@nestjs/common';
import { JobDetailSchema } from '@sponge/sponge.types';
import { renderCandidateCard } from '@tools/job-list/candidate-card.util';
import { extractHardRequirements } from '@tools/job-list/hard-requirements.util';
import { buildJobPolicyAnalysis } from '@tools/job-list/job-policy-parser';
import { formatJobsToMarkdown, type ProgressiveDisclosureFlags } from '@tools/job-list/render.util';
import { extractSalaryFacts, renderSalaryFactsBanner } from '@tools/job-list/salary-facts.util';
import { formatSettlementSummary } from '@tools/job-list/salary-settlement.util';
import { extractWelfareFacts, renderWelfareFactsBanner } from '@tools/job-list/welfare-facts.util';
import {
  getSpongeJobFixture,
  loadSpongeJobFixtures,
  SPONGE_JOB_FIXTURE_IDS as IDS,
} from '../../fixtures/sponge-jobs';

/**
 * 用海绵真实岗位数据（脱敏样例，见 tests/fixtures/sponge-jobs）跑渲染层：
 * 之前的单测都用手写 fixture（裸值 BPO、welfare.remark…），字段形态与现网不符却一直是绿的
 * （PRD R4 J1/J4/J9）。这里用真实取值断言关键字段真的出现在模型可见的输出里。
 */
const ALL_FLAGS: ProgressiveDisclosureFlags = {
  includeBasicInfo: true,
  includeJobSalary: true,
  includeWelfare: true,
  includeHiringRequirement: true,
  includeWorkTime: true,
  includeInterviewProcess: true,
};

function renderOne(jobId: number): string {
  return formatJobsToMarkdown([getSpongeJobFixture(jobId)], 1, 1, 1, ALL_FLAGS);
}

describe('sponge real job fixtures: 契约与渲染不抛错', () => {
  const jobs = loadSpongeJobFixtures();

  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('样例 22 条，全部通过 JobDetailSchema 校验', () => {
    expect(jobs).toHaveLength(22);
    for (const job of jobs) {
      const parsed = JobDetailSchema.safeParse(job);
      expect(parsed.success).toBe(true);
    }
  });

  it('样例已脱敏：无手机号、门店名为占位、地址只到区级、经纬度取整', () => {
    const text = JSON.stringify(jobs);
    expect(text).not.toMatch(/1[3-9]\d{9}/);
    for (const job of jobs) {
      const store = job.basicInfo?.storeInfo as Record<string, unknown>;
      expect(String(store.storeName)).toMatch(/^示例门店\d+$/);
      expect(store.storeAddress).toBe(`${store.storeCityName}${store.storeRegionName}`);
      expect(Number.isInteger(store.longitude)).toBe(true);
      expect(Number.isInteger(store.latitude)).toBe(true);
    }
  });

  it('formatJobsToMarkdown 六分区全开逐岗不抛错，且每岗输出岗位标识', () => {
    for (const job of jobs) {
      const md = formatJobsToMarkdown([job], 1, 1, 1, ALL_FLAGS);
      expect(md).toContain(`- **jobId**: ${job.basicInfo?.jobId}`);
    }
    const all = formatJobsToMarkdown(jobs, jobs.length, 1, jobs.length, ALL_FLAGS);
    expect(all).toContain(`# 在招岗位（共 ${jobs.length} 个）`);
  });

  it('候选人卡片 / 结算摘要 / 福利速览 / 薪资事实 / 招聘要求逐岗不抛错', () => {
    for (const job of jobs) {
      expect(renderCandidateCard(job, 0)).not.toBeNull();
      expect(() => formatSettlementSummary(job)).not.toThrow();
      const welfare = extractWelfareFacts(job.welfare);
      expect(() => renderWelfareFactsBanner(welfare)).not.toThrow();
      const salary = extractSalaryFacts(job.jobSalary);
      expect(() => renderSalaryFactsBanner(salary)).not.toThrow();
      const policy = buildJobPolicyAnalysis(job);
      expect(() => extractHardRequirements(job, policy)).not.toThrow();
    }
  });
});

describe('sponge real job fixtures: 关键字段进入输出', () => {
  beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('合作模式：海绵全称「招聘流程外包(RPO)」→ 输出 RPO 标记，不输出「外包」全称', () => {
    const md = renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(md).toMatch(/\*\*合作模式\*\*: RPO/);
    expect(md).not.toContain('招聘流程外包');
    expect(md).toContain('由客户（品牌方）发薪');
  });

  it('合作模式：「业务流程外包(BPO)」→ 输出 BPO 标记与独立客发薪结论', () => {
    const md = renderOne(IDS.PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY);
    expect(md).toMatch(/\*\*合作模式\*\*: BPO/);
    expect(md).not.toContain('业务流程外包');
    expect(md).toContain('由独立客发薪');
  });

  it('全部样例的合作模式都能归一（不再有未知取值静默丢弃）', () => {
    for (const job of loadSpongeJobFixtures()) {
      const md = formatJobsToMarkdown([job], 1, 1, 1, ALL_FLAGS);
      expect(md).toMatch(/\*\*合作模式\*\*: (BPO|RPO)/);
    }
  });

  it('结算周期 + 发薪日：周结每周三 / 月结 5 号（次月发上月）/ 日结次日结', () => {
    expect(renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW)).toContain(
      '- **结算周期**: 周结算, 每周三发薪',
    );
    expect(renderOne(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY)).toContain(
      '- **结算周期**: 月结算, 5号发薪（次月5号发上月工资，无当月发当月）',
    );
    expect(renderOne(528176)).toContain('- **结算周期**: 日结算, 次日结');
  });

  it('结算摘要读的是 welfare.memo（真实键），阶梯月结/日结备注进摘要', () => {
    expect(formatSettlementSummary(getSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW))).toBe(
      '正式:周结算（每周三发薪）',
    );
    const summary = formatSettlementSummary(
      getSpongeJobFixture(IDS.PIZZA_HUT_BPO_STAIR_BOTH_SIDES),
    );
    expect(summary).toContain('正式:日结算（当日结）');
    expect(summary).toContain('阶梯差价按月结');
    expect(summary).toContain('每月10号发上月差价');
  });

  it('福利备注 welfare.memo 原文进入福利分区', () => {
    const md = renderOne(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY);
    expect(md).toContain('- **备注**: 1.只要第二职业 24元/小时');
    const multiline = renderOne(IDS.PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY);
    expect(multiline).toContain('月工时 0-100小时，21元每小时');
    expect(multiline).toContain('月工时160小时以上，25元每小时');
  });

  it('结构化阶梯薪资三档全部渲染（含累计口径）', () => {
    const md = renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(md).toContain('- **是否阶梯薪资**: 有阶梯薪资');
    expect(md).toContain('- 累计满 100小时: 16 元/时（超出后所有工时按照新的薪资标准计算）');
    expect(md).toContain('- 累计满 180小时: 18 元/时');
  });

  it('最短用工月数：渲染层输出「最少工作月数」，硬约束层透传数字', () => {
    const md = renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(md).toContain('- **最少工作月数**: 6 个月');
    const job = getSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(extractHardRequirements(job, buildJobPolicyAnalysis(job)).minWorkMonths).toBe(6);
  });

  it('面试窗口：周期面试逐日渲染时段与报名截止', () => {
    const md = renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(md).toContain('- **时间模式**: 周期');
    expect(md).toContain('- **周期面试时间**:');
    expect(md).toContain('- 每周一 10:00-17:00（报名截止: 当天 09:00）');
    expect(md).toContain('- 每周五 10:00-17:00（报名截止: 当天 09:00）');
  });

  it('等待通知岗位：时间模式渲染为等待通知，不渲染周期时段', () => {
    const md = renderOne(IDS.DOMINOS_BPO_WAIT_NOTICE);
    expect(md).toContain('- **时间模式**: 等待通知');
    expect(md).not.toContain('- **周期面试时间**:');
  });

  it('节假日薪资：固定 50 元/日 + 说明；多倍 3 倍', () => {
    expect(renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW)).toContain('50');
    expect(renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW)).toContain(
      '当天出勤8H以上，发放50元/天',
    );
    expect(renderOne(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY)).toMatch(/节假日[^\n]*3/);
  });

  it('招聘要求：健康证 / 年龄 / 身份要求从真实结构取值', () => {
    const job = getSpongeJobFixture(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY);
    const hr = extractHardRequirements(job, buildJobPolicyAnalysis(job));
    expect(hr.gender).toBe('any');
    expect(hr.healthCert).not.toBe('unspecified');
    const md = renderOne(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY);
    expect(md).toContain('- **健康证**: 食品健康证');
    expect(md).toContain('第二职业');
    // 无证岗位（certificate 全空）不得凭空渲染健康证
    const kfc = getSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW);
    expect(extractHardRequirements(kfc, buildJobPolicyAnalysis(kfc)).healthCert).toBe(
      'unspecified',
    );
    expect(renderOne(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW)).toContain('- **年龄**: 18-50 岁');
  });

  it('福利速览：包吃岗位标公司提供，无餐饮福利岗位标无', () => {
    const withMeals = loadSpongeJobFixtures().find(
      (job) => (job.welfare as Record<string, unknown>).catering === '包吃',
    );
    expect(withMeals).toBeDefined();
    expect(extractWelfareFacts(withMeals?.welfare).meals).toBe('company');
    expect(
      extractWelfareFacts(getSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW).welfare).meals,
    ).toBe('self_or_none');
  });
});
