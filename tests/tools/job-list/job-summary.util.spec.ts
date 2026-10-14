import type { JobDetail } from '@sponge/sponge.types';
import { mapJobsToRecommendedSummaries } from '@tools/job-list/job-summary.util';

function makeJob(overrides: Record<string, unknown> = {}): JobDetail {
  return {
    basicInfo: {
      jobId: 101,
      brandName: '肯德基',
      jobName: '服务员',
      jobCategoryName: '餐饮服务',
      laborForm: '兼职',
      partTimeJobType: '小时工',
      storeInfo: {
        storeName: '上海静安寺店',
        storeAddress: '静安区南京西路 1 号',
        storeCityName: '上海',
        storeRegionName: '静安区',
      },
    },
    _distanceKm: 2.34,
    workTime: {
      dayWorkTime: {
        arrangementType: '固定排班',
        combinedArrangement: [
          { combinedArrangementStartTime: '11:00', combinedArrangementEndTime: '15:00' },
        ],
        fixedTime: null,
      },
      weekAndMonthWorkTime: { perWeekWorkDays: 4 },
    },
    jobSalary: {
      salaryScenarioList: [
        {
          comprehensiveSalary: {
            minComprehensiveSalary: 24,
            maxComprehensiveSalary: 29,
            comprehensiveSalaryUnit: '元/时',
          },
        },
      ],
    },
    hiringRequirement: {
      basicPersonalRequirements: { minAge: 18, maxAge: 50, genderRequirement: '不限' },
      certificate: { healthCertificate: '入职前办好健康证' },
    },
    ...overrides,
  } as unknown as JobDetail;
}

describe('mapJobsToRecommendedSummaries', () => {
  it('projects sponge job identity, store and labor form onto the shared summary shape', () => {
    const [summary] = mapJobsToRecommendedSummaries([makeJob()]);

    expect(summary).toMatchObject({
      jobId: 101,
      brandName: '肯德基',
      jobName: '服务员',
      storeName: '上海静安寺店',
      storeAddress: '静安区南京西路 1 号',
      cityName: '上海',
      regionName: '静安区',
      laborForm: '兼职',
      partTimeJobType: '小时工',
      jobCategoryName: '餐饮服务',
    });
    expect(summary.salaryDesc).toBeTruthy();
    expect(summary.shiftSummary).toBeTruthy();
  });

  it('rounds the synthetic _distanceKm annotation to one decimal, and keeps null when absent', () => {
    expect(mapJobsToRecommendedSummaries([makeJob()])[0].distanceKm).toBe(2.3);
    expect(
      mapJobsToRecommendedSummaries([makeJob({ _distanceKm: undefined })])[0].distanceKm,
    ).toBeNull();
  });

  it('drops non-constraining requirement placeholders（记忆里不留「不限」噪声）', () => {
    const [summary] = mapJobsToRecommendedSummaries([
      makeJob({
        hiringRequirement: {
          basicPersonalRequirements: { genderRequirement: '不限', educationRequirement: '不限' },
          certificate: {},
        },
      }),
    ]);

    expect(summary.ageRequirement).toBeNull();
    expect(summary.educationRequirement).toBeNull();
    expect(summary.healthCertificateRequirement).toBeNull();
  });

  it('keeps welfare facts only when a welfare payload exists, capping other items by count and length', () => {
    const [withoutWelfare] = mapJobsToRecommendedSummaries([makeJob()]);
    expect(withoutWelfare.welfareFacts).toBeNull();

    const [withWelfare] = mapJobsToRecommendedSummaries([
      makeJob({
        welfare: {
          otherWelfare: Array.from({ length: 8 }, (_, i) => `福利${i}${'长'.repeat(200)}`).join(
            '\n',
          ),
        },
      }),
    ]);

    expect(withWelfare.welfareFacts).not.toBeNull();
    expect(withWelfare.welfareFacts!.otherWelfareItems.length).toBeLessThanOrEqual(5);
    for (const item of withWelfare.welfareFacts!.otherWelfareItems) {
      expect(item.length).toBeLessThanOrEqual(120);
    }
  });

  it('tolerates a missing storeInfo instead of throwing', () => {
    const [summary] = mapJobsToRecommendedSummaries([
      makeJob({
        basicInfo: { jobId: 202, brandName: '海底捞', jobName: '传菜员' },
      }),
    ]);

    expect(summary).toMatchObject({
      jobId: 202,
      storeName: null,
      storeAddress: null,
      cityName: null,
      regionName: null,
    });
  });

  describe('学生身份档位（与查岗侧学生硬过滤、岗位卡同源）', () => {
    const withIdentity = (hiring: Record<string, unknown>) =>
      mapJobsToRecommendedSummaries([
        makeJob({
          hiringRequirement: {
            basicPersonalRequirements: { minAge: 18, maxAge: 50 },
            ...hiring,
          },
        }),
      ])[0];

    it('figure=社会人士 且无备注 → social_only，记忆文案与岗位卡一致（此前无备注时记忆里没有学生信息）', () => {
      const summary = withIdentity({ figure: '社会人士' });
      expect(summary.studentTier).toBe('social_only');
      expect(summary.studentRequirement).toBe('不接受学生（仅限社会人士）');
    });

    it('figure=不限 + 备注含「社会人士」→ any，不再被备注里的四个字推断成不接受学生', () => {
      const summary = withIdentity({ figure: '不限', remark: '社会人士、学生均可，需健康证' });
      expect(summary.studentTier).toBe('any');
      expect(summary.studentRequirement).toBe('不限身份，学生与社会人士均可');
    });

    it('社会身份字段为空 → unspecified，文案标明疑似数据缺失而非不限身份', () => {
      const summary = withIdentity({});
      expect(summary.studentTier).toBe('unspecified');
      expect(summary.studentRequirement).toContain('岗位数据未下发社会身份要求');
      expect(summary.studentRequirement).not.toContain('不限身份，');
    });

    it('figure=第二职业 → second_job_only（需已有主职，不接受在校学生）', () => {
      const summary = withIdentity({ figure: '第二职业' });
      expect(summary.studentTier).toBe('second_job_only');
      expect(summary.studentRequirement).toContain('不接受学生');
    });
  });

  it('maps every job in the batch', () => {
    const summaries = mapJobsToRecommendedSummaries([
      makeJob(),
      makeJob({ basicInfo: { jobId: 102, brandName: '瑞幸', jobName: '咖啡师' } }),
    ]);
    expect(summaries.map((s) => s.jobId)).toEqual([101, 102]);
  });
});
