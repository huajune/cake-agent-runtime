import {
  applyLaborFormConstraint,
  applyScheduleConstraint,
  collectLaborFormAnomalies,
  filterJobsByRequestedCategories,
  filterJobsExcludingBrands,
  filterJobsToAppliedBrands,
  formatScheduleConstraintLabel,
  haversineDistance,
  scoreJobAgainstRequestedCategories,
} from '@tools/duliday/job-list/search.util';

describe('job-list search util', () => {
  describe('filterJobsToAppliedBrands（§8.2 入口标准化后的等值比较）', () => {
    const dami = { basicInfo: { jobId: 1, brandName: '大米先生' } };
    const swei = { basicInfo: { jobId: 2, brandName: '史伟莎销售' } };
    const kfc = { basicInfo: { jobId: 3, brandId: 10001, brandName: '肯德基' } };
    const noBrand = { basicInfo: { jobId: 4 } };

    it('returns all jobs when target empty', () => {
      const out = filterJobsToAppliedBrands([dami, swei], { brandIds: [], canonicalNames: [] });
      expect(out).toHaveLength(2);
    });

    it('keeps only jobs whose brandName equals the canonical name (badcase bb012h5c)', () => {
      const out = filterJobsToAppliedBrands([dami, swei, kfc], {
        brandIds: [],
        canonicalNames: ['大米先生'],
      });
      expect(out).toEqual([dami]);
    });

    it('matches by brandId when present', () => {
      const out = filterJobsToAppliedBrands([dami, kfc], {
        brandIds: [10001],
        canonicalNames: [],
      });
      expect(out).toEqual([kfc]);
    });

    it('equality is normalized (case/separators) but NOT substring containment', () => {
      const brandWithSpace = { basicInfo: { jobId: 5, brandName: 'M Stand' } };
      expect(
        filterJobsToAppliedBrands([brandWithSpace], { brandIds: [], canonicalNames: ['mstand'] }),
      ).toEqual([brandWithSpace]);
      // 私有包含匹配已废弃（§5.1）："肯德基" 不再命中 "KFC肯德基" 这类非等值品牌名
      const kfcVariant = { basicInfo: { jobId: 6, brandName: 'KFC肯德基' } };
      expect(
        filterJobsToAppliedBrands([kfcVariant], { brandIds: [], canonicalNames: ['肯德基'] }),
      ).toEqual([]);
    });

    it('drops jobs with missing brandName', () => {
      const out = filterJobsToAppliedBrands([dami, noBrand], {
        brandIds: [],
        canonicalNames: ['大米先生'],
      });
      expect(out).toEqual([dami]);
    });

    it('accepts any of multiple canonical names', () => {
      const out = filterJobsToAppliedBrands([dami, swei, kfc], {
        brandIds: [],
        canonicalNames: ['大米先生', '肯德基'],
      });
      expect(out).toEqual([dami, kfc]);
    });
  });

  describe('filterJobsExcludingBrands（§8.1 exclude 本地后过滤）', () => {
    const dami = { basicInfo: { jobId: 1, brandName: '大米先生' } };
    const kfc = { basicInfo: { jobId: 3, brandId: 10001, brandName: '肯德基' } };

    it('removes excluded brands by name or id, keeps the rest', () => {
      expect(
        filterJobsExcludingBrands([dami, kfc], { brandIds: [10001], canonicalNames: [] }),
      ).toEqual([dami]);
      expect(
        filterJobsExcludingBrands([dami, kfc], { brandIds: [], canonicalNames: ['大米先生'] }),
      ).toEqual([kfc]);
    });

    it('returns all jobs when target empty', () => {
      expect(filterJobsExcludingBrands([dami, kfc], { brandIds: [], canonicalNames: [] })).toEqual([
        dami,
        kfc,
      ]);
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

  describe('applyLaborFormConstraint (用工形式过滤，严格按新契约两级字段)', () => {
    const noLaborForm = { basicInfo: { jobId: 4, brandName: '星巴克', laborForm: null } };
    const fullTimeJob = { basicInfo: { jobId: 5, brandName: 'Tims', laborForm: '全职' } };
    const plainPartTimeJob = {
      basicInfo: { jobId: 6, brandName: '瑞幸', laborForm: '兼职', partTimeJobType: null },
    };
    const summerJob = {
      basicInfo: { jobId: 11, brandName: '肯德基', laborForm: '兼职', partTimeJobType: '暑假工' },
    };
    const hourlyJob = {
      basicInfo: { jobId: 12, brandName: '麦当劳', laborForm: '兼职', partTimeJobType: '小时工' },
    };
    // 历史扁平脏数据（细分值写在 laborForm 上）：匹配层不兜底，应处处不被认作兼职形态
    const dirtyFlatSummerJob = {
      basicInfo: { jobId: 7, brandName: '必胜客', laborForm: '暑假工' },
    };
    const dirtyFlatHourlyJob = {
      basicInfo: { jobId: 8, brandName: '汉堡王', laborForm: '小时工' },
    };

    it('does not filter when candidate has no labor form preference', () => {
      const result = applyLaborFormConstraint([summerJob, hourlyJob], null);
      expect(result.applied).toBe(false);
      expect(result.jobs).toHaveLength(2);
    });

    it('全职: keeps only jobs whose laborForm is 全职 (must be field-backed)', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, hourlyJob, plainPartTimeJob, noLaborForm],
        '全职',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([fullTimeJob]);
      expect(result.excluded.map((e) => e.jobId)).toEqual([12, 6, 4]);
    });

    it('兼职: parent-level match keeps all 兼职 jobs regardless of subdivision', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, summerJob, hourlyJob, plainPartTimeJob, noLaborForm],
        '兼职',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([summerJob, hourlyJob, plainPartTimeJob]);
      expect(result.relaxedToFamily).toBe(false);
      expect(result.excluded.map((e) => e.jobId)).toEqual([5, 4]);
    });

    it('暑假工: matches laborForm=兼职 + partTimeJobType=暑假工', () => {
      const result = applyLaborFormConstraint(
        [fullTimeJob, summerJob, hourlyJob, plainPartTimeJob],
        '暑假工',
      );
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([summerJob]);
      expect(result.relaxedToFamily).toBe(false);
      expect(result.excluded.map((e) => e.jobId)).toEqual([5, 12, 6]);
    });

    it('小时工: exact partTimeJobType match wins without relaxation', () => {
      const result = applyLaborFormConstraint([summerJob, hourlyJob], '小时工');
      expect(result.jobs).toEqual([hourlyJob]);
      expect(result.relaxedToFamily).toBe(false);
    });

    it('全职: never repackages part-time as full-time (excludes all → empty)', () => {
      const result = applyLaborFormConstraint([hourlyJob, plainPartTimeJob, noLaborForm], '全职');
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([]);
      expect(result.excluded).toHaveLength(3);
      expect(result.relaxedToFamily).toBe(false);
    });

    it('寒假工: no exact subdivision → relaxes to laborForm=兼职 family with signal', () => {
      const result = applyLaborFormConstraint([fullTimeJob, summerJob, plainPartTimeJob], '寒假工');
      expect(result.applied).toBe(true);
      expect(result.relaxedToFamily).toBe(true);
      expect(result.jobs).toEqual([summerJob, plainPartTimeJob]);
    });

    it('暑假工: strict-empty does NOT relax to part-time family during summer guard period', () => {
      const result = applyLaborFormConstraint([fullTimeJob, plainPartTimeJob, hourlyJob], '暑假工');
      expect(result.applied).toBe(true);
      expect(result.relaxedToFamily).toBe(false);
      expect(result.jobs).toEqual([]);
    });

    it('全职: strict-empty does NOT relax (full-time is not in the family)', () => {
      const result = applyLaborFormConstraint([hourlyJob, plainPartTimeJob], '全职');
      expect(result.jobs).toEqual([]);
      expect(result.relaxedToFamily).toBe(false);
    });

    it('兼职: family relax still empty when nearby jobs are all full-time', () => {
      const result = applyLaborFormConstraint([fullTimeJob, noLaborForm], '兼职');
      expect(result.applied).toBe(true);
      expect(result.jobs).toEqual([]);
      expect(result.relaxedToFamily).toBe(false);
    });

    it('excluded entries expose partTimeJobType for honest explanations', () => {
      const result = applyLaborFormConstraint([hourlyJob], '暑假工');
      expect(result.jobs).toEqual([]);
      expect(result.excluded).toEqual([
        { jobId: 12, brandName: '麦当劳', laborForm: '兼职', partTimeJobType: '小时工' },
      ]);
    });

    // ===== 历史扁平脏数据：不兼容不兜底，匹配不上是预期行为 =====

    it('dirty flat laborForm=暑假工 does NOT match wanted 暑假工 (no legacy fallback)', () => {
      const result = applyLaborFormConstraint([dirtyFlatSummerJob], '暑假工');
      expect(result.jobs).toEqual([]);
      expect(result.relaxedToFamily).toBe(false);
    });

    it('dirty flat labels do NOT participate in family relaxation', () => {
      const result = applyLaborFormConstraint(
        [dirtyFlatSummerJob, dirtyFlatHourlyJob, plainPartTimeJob],
        '寒假工',
      );
      expect(result.relaxedToFamily).toBe(true);
      expect(result.jobs).toEqual([plainPartTimeJob]);
    });
  });

  describe('collectLaborFormAnomalies (契约异常数据暴露)', () => {
    it('flags subdivision values written on laborForm (legacy flat data)', () => {
      const anomalies = collectLaborFormAnomalies([
        { basicInfo: { jobId: 7, brandName: '必胜客', laborForm: '暑假工' } },
        {
          basicInfo: {
            jobId: 12,
            brandName: '麦当劳',
            laborForm: '兼职',
            partTimeJobType: '小时工',
          },
        },
      ]);
      expect(anomalies).toEqual([
        {
          jobId: 7,
          brandName: '必胜客',
          laborForm: '暑假工',
          partTimeJobType: null,
          reason: 'labor_form_not_in_axis',
        },
      ]);
    });

    it('flags unknown partTimeJobType and 全职-with-subdivision contradictions', () => {
      const anomalies = collectLaborFormAnomalies([
        { basicInfo: { jobId: 1, laborForm: '兼职', partTimeJobType: '日结工' } },
        { basicInfo: { jobId: 2, laborForm: '全职', partTimeJobType: '小时工' } },
      ]);
      expect(anomalies.map((a) => a.reason)).toEqual([
        'part_time_job_type_not_in_axis',
        'full_time_with_part_time_job_type',
      ]);
    });

    it('returns empty for contract-conforming jobs (null fields are fine)', () => {
      const anomalies = collectLaborFormAnomalies([
        { basicInfo: { jobId: 1, laborForm: '全职' } },
        { basicInfo: { jobId: 2, laborForm: '兼职', partTimeJobType: '暑假工' } },
        { basicInfo: { jobId: 3, laborForm: null } },
      ]);
      expect(anomalies).toEqual([]);
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
