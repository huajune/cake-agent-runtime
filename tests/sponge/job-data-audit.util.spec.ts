import {
  auditJobData,
  auditJobDataBatch,
  countJobDataIssuesByKind,
  formatJobDataAuditReport,
  type JobDataIssue,
} from '@sponge/job-data-audit.util';
import {
  buildSpongeJobFixture,
  getSpongeJobFixture,
  loadSpongeJobFixtures,
  SPONGE_JOB_FIXTURE_IDS as IDS,
} from '../fixtures/sponge-jobs';

function kindsOf(issues: JobDataIssue[]): string[] {
  return issues.map((issue) => issue.kind);
}

function firstScenario(job: ReturnType<typeof getSpongeJobFixture>): Record<string, unknown> {
  const salary = job.jobSalary as { salaryScenarioList: Record<string, unknown>[] };
  return salary.salaryScenarioList[0];
}

describe('auditJobData ① 阶梯只在备注、结构化为空', () => {
  it.each([
    IDS.PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY,
    IDS.NILIUJIE_BPO_STAIR_IN_MEMO_ONLY,
    IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT,
    IDS.ALDI_BPO_TENURE_TIERS_IN_MEMO,
  ])('真实样例 %s 命中', (jobId) => {
    const issues = auditJobData(getSpongeJobFixture(jobId));
    const hit = issues.find((issue) => issue.kind === 'stair_text_without_structure');
    expect(hit).toBeDefined();
    expect(hit?.jobId).toBe(jobId);
    expect(hit?.detail).toContain('结构化阶梯字段为空');
  });

  it('结构化已有阶梯时，备注再写阶梯也不报（两边都写不算本类问题）', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.PIZZA_HUT_BPO_STAIR_BOTH_SIDES));
    expect(kindsOf(issues)).not.toContain('stair_text_without_structure');
  });

  it('备注只有「每周至少2天 每天4-6小时」这类排班文本不误报', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY));
    expect(kindsOf(issues)).not.toContain('stair_text_without_structure');
  });

  it('装备说明类备注不误报', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.DOMINOS_BPO_ZERO_MIN_COMPREHENSIVE));
    expect(kindsOf(issues)).not.toContain('stair_text_without_structure');
  });

  it('奖金说明里写「满 100 单」同样命中', () => {
    const job = buildSpongeJobFixture(IDS.GUOSHUHAO_BPO_HOUSEHOLD_EXCLUDE, (draft) => {
      firstScenario(draft).bonusDesc = '当月满100单按每单加 1 元';
    });
    const hit = auditJobData(job).find((issue) => issue.kind === 'stair_text_without_structure');
    expect(hit?.detail).toContain('奖金说明');
    expect(hit?.detail).toContain('满100单');
  });
});

describe('auditJobData ② 节假日薪资两处矛盾', () => {
  it('结构化「无薪资」而备注写「法定单价55.5」→ 命中', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT));
    const hit = issues.find((issue) => issue.kind === 'holiday_salary_conflict');
    expect(hit?.detail).toContain('无薪资');
    expect(hit?.detail).toContain('55.5');
  });

  it('结构化固定 50 元/日 + 说明「发放50元/天」一致 → 不报', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW));
    expect(kindsOf(issues)).not.toContain('holiday_salary_conflict');
  });

  it('说明是分档描述、无带单位数字（「<100为38」）→ 不报', () => {
    const issues = auditJobData(getSpongeJobFixture(IDS.PIZZA_HUT_BPO_STAIR_BOTH_SIDES));
    expect(kindsOf(issues)).not.toContain('holiday_salary_conflict');
  });

  it('结构化多倍 3 倍 + 备注写「法定 2 倍」→ 命中；写「法定3倍」→ 不报', () => {
    const conflict = buildSpongeJobFixture(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY, (draft) => {
      (draft.welfare as Record<string, unknown>).memo = '法定节假日 2 倍工资';
    });
    expect(kindsOf(auditJobData(conflict))).toContain('holiday_salary_conflict');

    const consistent = buildSpongeJobFixture(IDS.HAAGEN_DAZS_RPO_MULTIPLE_HOLIDAY, (draft) => {
      (draft.welfare as Record<string, unknown>).memo = '法定3倍';
    });
    expect(kindsOf(auditJobData(consistent))).not.toContain('holiday_salary_conflict');
  });

  it('结构化固定 45 元/时 + 备注写「节假日 55 元」→ 命中', () => {
    const job = buildSpongeJobFixture(IDS.PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY, (draft) => {
      (draft.welfare as Record<string, unknown>).memo = '节假日 55 元/小时';
    });
    const hit = auditJobData(job).find((issue) => issue.kind === 'holiday_salary_conflict');
    expect(hit?.detail).toContain('固定薪资 45元/时');
    expect(hit?.detail).toContain('55');
  });
});

describe('auditJobData ③ 综合薪资上下限比例', () => {
  it('真实样例（2000-6000、1000-3000、0-110）都不报', () => {
    const issues = auditJobDataBatch(loadSpongeJobFixtures());
    expect(kindsOf(issues)).not.toContain('comprehensive_salary_ratio');
  });

  it('2000-40000（疑似多打一个零）→ 命中', () => {
    const job = buildSpongeJobFixture(IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT, (draft) => {
      (firstScenario(draft).comprehensiveSalary as Record<string, unknown>).maxComprehensiveSalary =
        40000;
    });
    const hit = auditJobData(job).find((issue) => issue.kind === 'comprehensive_salary_ratio');
    expect(hit?.detail).toContain('2000-40000');
    expect(hit?.detail).toContain('20.0');
  });

  it('下限大于上限 → 命中', () => {
    const job = buildSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW, (draft) => {
      const comp = firstScenario(draft).comprehensiveSalary as Record<string, unknown>;
      comp.minComprehensiveSalary = 5000;
      comp.maxComprehensiveSalary = 4000;
    });
    const hit = auditJobData(job).find((issue) => issue.kind === 'comprehensive_salary_ratio');
    expect(hit?.detail).toContain('下限 5000 大于上限 4000');
  });
});

describe('auditJobData ④ 发薪日为空', () => {
  it('真实样例 22 岗发薪日都有值 → 不报', () => {
    expect(kindsOf(auditJobDataBatch(loadSpongeJobFixtures()))).not.toContain('payday_missing');
  });

  it.each(['', null, undefined, '   '])('payday=%p → 命中', (payday) => {
    const job = buildSpongeJobFixture(IDS.KFC_RPO_STAIR_PERIODIC_INTERVIEW, (draft) => {
      firstScenario(draft).payday = payday;
    });
    const hit = auditJobData(job).find((issue) => issue.kind === 'payday_missing');
    expect(hit?.detail).toBe('正式（周结算）发薪日 payday 为空');
  });
});

describe('auditJobData 输入容错与汇总', () => {
  it('非对象 / 无薪资块输入不抛错', () => {
    expect(auditJobData(null)).toEqual([]);
    expect(auditJobData('x')).toEqual([]);
    expect(auditJobData({ basicInfo: { jobId: 1 } })).toEqual([]);
  });

  it('真实 22 岗整体扫描：只有已知的 4 个岗位命中，且不含联系人信息', () => {
    const issues = auditJobDataBatch(loadSpongeJobFixtures());
    const jobIds = new Set(issues.map((issue) => issue.jobId));
    expect([...jobIds].sort()).toEqual(
      [
        IDS.PIZZA_HUT_BPO_STAIR_IN_MEMO_ONLY,
        IDS.NILIUJIE_BPO_STAIR_IN_MEMO_ONLY,
        IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT,
        IDS.ALDI_BPO_TENURE_TIERS_IN_MEMO,
        520423,
      ].sort(),
    );
    expect(countJobDataIssuesByKind(issues)).toEqual({
      stair_text_without_structure: 5,
      holiday_salary_conflict: 1,
      comprehensive_salary_ratio: 0,
      payday_missing: 0,
    });
    const report = formatJobDataAuditReport(issues);
    expect(report).toContain('【备注有阶梯而结构化标无】5 条');
    expect(report).toContain(`- ${IDS.PIZZA_HUT_BPO_HOLIDAY_CONFLICT} 必胜客：`);
    expect(report).not.toMatch(/1[3-9]\d{9}/);
  });

  it('报告超过 maxLines 时截断并注明总行数', () => {
    const issues: JobDataIssue[] = Array.from({ length: 5 }, (_, i) => ({
      jobId: i,
      brandName: '品牌',
      kind: 'payday_missing',
      detail: '发薪日为空',
    }));
    const report = formatJobDataAuditReport(issues, 3);
    expect(report.split('\n')).toHaveLength(4);
    expect(report).toContain('共 6 行，已截断');
  });
});
