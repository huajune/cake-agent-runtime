import {
  applyLaborFormConstraint,
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

    it('matches when alias is brand + generic store suffix (e.g. brand "肯德基" + alias "肯德基店")', () => {
      const job = { basicInfo: { jobId: 5, brandName: '肯德基' } };
      const out = filterJobsToRequestedBrands([job], ['肯德基店']);
      expect(out).toEqual([job]);
    });

    it('matches when alias is brand + 门店/分店 suffix', () => {
      const job = { basicInfo: { jobId: 6, brandName: '麦当劳' } };
      expect(filterJobsToRequestedBrands([job], ['麦当劳门店'])).toEqual([job]);
      expect(filterJobsToRequestedBrands([job], ['麦当劳分店'])).toEqual([job]);
      expect(filterJobsToRequestedBrands([job], ['麦当劳旗舰店'])).toEqual([job]);
    });

    it('does NOT match noise-y alias that merely contains brand as substring (e.g. "汉堡不错" vs brand "汉堡")', () => {
      // review feedback：裸 alias.includes(brandName) 反向匹配会让"汉堡不错"误伤"汉堡"品牌。
      // 现在策略改为只走 forward + 剥常见门店后缀，"不错" 不在后缀白名单里，应该被排除。
      const job = { basicInfo: { jobId: 7, brandName: '汉堡' } };
      expect(filterJobsToRequestedBrands([job], ['汉堡不错'])).toEqual([]);
    });

    it('does NOT match when brand is a single-char substring of unrelated alias', () => {
      // 极短品牌名时的退化场景：brand "汉" 不应被任意含 "汉" 字符的 alias 命中
      const job = { basicInfo: { jobId: 8, brandName: '汉' } };
      expect(filterJobsToRequestedBrands([job], ['汉堡王不错'])).toEqual([]);
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

  describe('applyLaborFormConstraint (用工形式过滤)', () => {
    const summerJob = { basicInfo: { jobId: 1, brandName: '肯德基', laborForm: '暑假工' } };
    const hourlyJob = { basicInfo: { jobId: 2, brandName: '麦当劳', laborForm: '小时工' } };
    const plusJob = { basicInfo: { jobId: 3, brandName: '必胜客', laborForm: '兼职+' } };
    const noLaborForm = { basicInfo: { jobId: 4, brandName: '星巴克', laborForm: null } };
    const fullTimeJob = { basicInfo: { jobId: 5, brandName: 'Tims', laborForm: '全职' } };
    const partTimeJob = { basicInfo: { jobId: 6, brandName: '瑞幸', laborForm: '兼职' } };

    it('小时工: keeps only jobs whose laborForm is 小时工', () => {
      const result = applyLaborFormConstraint([summerJob, hourlyJob, plusJob], '小时工');
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([hourlyJob]);
      expect(result.excluded.map((e) => e.jobId)).toEqual([1, 3]);
    });

    it('does not filter when candidate has no labor form preference', () => {
      const result = applyLaborFormConstraint([summerJob, hourlyJob], null);
      expect(result.applied).toBe(false);
      expect(result.jobs).toHaveLength(2);
    });

    it('全职: keeps only jobs whose laborForm is 全职 (must be field-backed)', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, hourlyJob, partTimeJob, noLaborForm],
        '全职',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([fullTimeJob]);
      expect(result.excluded.map((e) => e.jobId)).toEqual([2, 6, 4]);
    });

    it('兼职: keeps only jobs whose laborForm is 兼职', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, hourlyJob, plusJob, summerJob, partTimeJob, noLaborForm],
        '兼职',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([partTimeJob]);
      expect(result.excluded.map((e) => e.jobId)).toEqual([5, 2, 3, 1, 4]);
    });

    it('暑假工: keeps only jobs whose laborForm is 暑假工', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, summerJob, hourlyJob, plusJob, noLaborForm],
        '暑假工',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([summerJob]);
      expect(result.excluded.map((e) => e.jobId)).toEqual([5, 2, 3, 4]);
    });

    it('全职: never repackages part-time as full-time (excludes all → empty)', () => {
      const result = applyLaborFormConstraint([hourlyJob, partTimeJob, noLaborForm], '全职');
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([]);
      expect(result.excluded).toHaveLength(3);
    });
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
