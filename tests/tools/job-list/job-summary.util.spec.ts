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
        arrangementType: '满足其中一个时段即可安排上岗',
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

  it('maps every job in the batch', () => {
    const summaries = mapJobsToRecommendedSummaries([
      makeJob(),
      makeJob({ basicInfo: { jobId: 102, brandName: '瑞幸', jobName: '咖啡师' } }),
    ]);
    expect(summaries.map((s) => s.jobId)).toEqual([101, 102]);
  });
});
