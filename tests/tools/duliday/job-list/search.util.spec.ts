import {
  applyScheduleConstraint,
  filterJobsByRequestedCategories,
  filterJobsToRequestedBrands,
  formatScheduleConstraintLabel,
  haversineDistance,
  scoreJobAgainstRequestedCategories,
} from '@tools/duliday/job-list/search.util';

describe('job-list search util', () => {
  describe('filterJobsToRequestedBrands (Phase 1.C.3)', () => {
    const dami = { basicInfo: { jobId: 1, brandName: '大米先生' } };
    const swei = { basicInfo: { jobId: 2, brandName: '史伟莎销售' } };
    const kfc = { basicInfo: { jobId: 3, brandName: 'KFC肯德基' } };
    const noBrand = { basicInfo: { jobId: 4 } };

    it('returns all jobs when brandAliasList empty', () => {
      const out = filterJobsToRequestedBrands([dami, swei], []);
      expect(out).toHaveLength(2);
    });

    it('keeps only jobs whose brandName contains the alias (substring)', () => {
      const out = filterJobsToRequestedBrands([dami, swei, kfc], ['大米先生']);
      expect(out).toEqual([dami]);
    });

    it('matches when alias is a substring of brandName (e.g. "肯德基" in "KFC肯德基")', () => {
      const out = filterJobsToRequestedBrands([dami, kfc], ['肯德基']);
      expect(out).toEqual([kfc]);
    });

    it('matches when brandName is a substring of alias (e.g. brand "肯德基" + alias "肯德基店")', () => {
      const job = { basicInfo: { jobId: 5, brandName: '肯德基' } };
      const out = filterJobsToRequestedBrands([job], ['肯德基店']);
      expect(out).toEqual([job]);
    });

    it('drops jobs with missing brandName', () => {
      const out = filterJobsToRequestedBrands([dami, noBrand], ['大米先生']);
      expect(out).toEqual([dami]);
    });

    it('accepts any of multiple aliases', () => {
      const out = filterJobsToRequestedBrands([dami, swei, kfc], ['大米先生', '肯德基']);
      expect(out).toEqual([dami, kfc]);
    });
  });

  it('calculates haversine distance in kilometers', () => {
    const distance = haversineDistance(31.2304, 121.4737, 31.2206, 121.5503);

    expect(distance).toBeGreaterThan(7);
    expect(distance).toBeLessThan(8);
  });

  it('scores requested categories against category/name/nickname/content and filters by relevance', () => {
    const service = makeJob(1, '服务员', '前厅服务员', '餐厅服务', '负责前台点餐');
    const cashier = makeJob(2, '收银员', '门店收银', '收银', '负责收银');
    const warehouse = makeJob(3, '分拣员', '仓库分拣', '仓储', '理货上架');

    expect(scoreJobAgainstRequestedCategories(service, ['服务员'])).toBeGreaterThan(
      scoreJobAgainstRequestedCategories(cashier, ['服务员']),
    );
    expect(filterJobsByRequestedCategories([cashier, warehouse, service], ['服务员'])).toEqual([
      service,
    ]);
  });

  it('formats candidate schedule constraints into a compact label', () => {
    expect(
      formatScheduleConstraintLabel({
        onlyWeekends: true,
        onlyEvenings: true,
        maxDaysPerWeek: 2,
      }),
    ).toBe('只周末 / 只晚班 / 每周最多 2 天');
    expect(formatScheduleConstraintLabel({})).toBe('未明确');
  });

  it('applies schedule constraints and records semantic exclusions', () => {
    const weekendJob = makeJob(1, '服务员', '周末短班', '餐饮', '可只做周末');
    const fullWeekJob = makeJob(2, '服务员', '全周排班', '餐饮', '每天 05:00-23:00 固定排班');

    const result = applyScheduleConstraint([fullWeekJob, weekendJob], { onlyWeekends: true });

    expect(result.jobs).toEqual([weekendJob]);
    expect((weekendJob as JobWithScheduleSemantic)._scheduleSemantic).toContain(
      'weekend_only_compatible',
    );
    expect(result.excluded).toEqual([
      {
        jobId: 2,
        brandName: '肯德基',
        reason: '岗位是全周强排班，与"只做周末"冲突',
      },
    ]);
  });
});

function makeJob(
  jobId: number,
  jobCategoryName: string,
  jobName: string,
  jobNickName: string,
  jobContent: string,
) {
  return {
    basicInfo: {
      jobId,
      brandName: '肯德基',
      jobCategoryName,
      jobName,
      jobNickName,
      jobContent,
    },
    workTime: { remark: jobContent },
    hiringRequirement: { remark: jobContent },
  };
}

type JobWithScheduleSemantic = ReturnType<typeof makeJob> & {
  _scheduleSemantic?: string[];
};
