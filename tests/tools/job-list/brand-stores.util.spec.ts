import {
  buildBrandNearestStoreSummary,
  formatSalarySummary,
  getMultiStoreBrandGroups,
  renderMultiStoreBrandWarning,
} from '@tools/job-list/brand-stores.util';

describe('job-list brand-stores util', () => {
  it('formats salary summaries from comprehensive, basic and probation salary fields', () => {
    expect(
      formatSalarySummary({
        jobSalary: {
          salaryScenarioList: [
            {
              comprehensiveSalary: {
                minComprehensiveSalary: 24,
                maxComprehensiveSalary: 26,
                comprehensiveSalaryUnit: '元/时',
              },
            },
          ],
        },
      }),
    ).toBe('24-26元/时');

    expect(
      formatSalarySummary({
        jobSalary: {
          salaryScenarioList: [{ basicSalary: { basicSalary: 180, basicSalaryUnit: '元/天' } }],
        },
      }),
    ).toBe('180元/天');

    expect(
      formatSalarySummary({
        jobSalary: { probationSalary: { salary: 20, salaryUnit: '元/时' } },
      }),
    ).toBe('20元/时（试工期）');

    expect(formatSalarySummary({ jobSalary: null })).toBeNull();
  });

  it('groups same-brand stores, sorts by nearest distance, trims city prefix and keeps top three', () => {
    const summary = buildBrandNearestStoreSummary([
      makeJob(1, '肯德基', 100, '上海日月光店', 5.06, 23),
      makeJob(2, '肯德基', 100, '上海绿地缤纷城店', 2.34, 24),
      makeJob(3, '肯德基', 100, '上海虹桥店', 8.49, 25),
      makeJob(4, '肯德基', 100, '上海静安寺店', 9.91, 26),
      makeJob(5, '麦当劳', 200, '上海徐汇店', 3, 22),
      { basicInfo: { brandName: '无效品牌', brandId: 300 } },
    ]);

    expect(summary).toEqual([
      expect.objectContaining({
        brandName: '肯德基',
        brandId: 100,
        totalStoreCount: 4,
        nearestStores: [
          expect.objectContaining({
            storeName: '绿地缤纷城店',
            jobId: 2,
            distanceKm: 2.3,
            displayLine: '肯德基（绿地缤纷城店，2.3km，24-29元/时）',
          }),
          expect.objectContaining({ storeName: '日月光店', jobId: 1, distanceKm: 5.1 }),
          expect.objectContaining({ storeName: '虹桥店', jobId: 3, distanceKm: 8.5 }),
        ],
      }),
      expect.objectContaining({
        brandName: '麦当劳',
        totalStoreCount: 1,
      }),
    ]);
  });

  it('renders warning markdown only for brands with multiple stores', () => {
    const groups = buildBrandNearestStoreSummary([
      makeJob(1, '肯德基', 100, '绿地缤纷城店', 2.3, 24),
      makeJob(2, '肯德基', 100, '日月光店', 5.1, 24),
      makeJob(3, '麦当劳', 200, '徐汇店', 1.2, 22),
    ]);

    expect(getMultiStoreBrandGroups(groups)).toHaveLength(1);
    expect(renderMultiStoreBrandWarning(groups)).toContain('## ⚠️ 同品牌多门店');
    expect(renderMultiStoreBrandWarning(groups)).toContain(
      '肯德基（绿地缤纷城店，2.3km，24-29元/时）',
    );
    const singleStoreGroup = groups!.find((group) => group.brandName === '麦当劳');
    expect(renderMultiStoreBrandWarning(singleStoreGroup ? [singleStoreGroup] : [])).toBeNull();
  });

  it('counts distinct stores and keeps different nearby stores in the top three despite multiple jobs', () => {
    const jobs = [
      makeJob(1, '成都你六姐', 10200, '太仓万达店', 1, 22),
      makeJob(2, '成都你六姐', 10200, '太仓万达店', 1, 24),
      makeJob(3, '成都你六姐', 10200, '太仓万达店', 1, 26),
      makeJob(4, '成都你六姐', 10200, '中骏世界店', 2, 22),
      makeJob(5, '成都你六姐', 10200, '第三家店', 3, 22),
    ].map((job, index) => ({
      ...job,
      basicInfo: {
        ...job.basicInfo,
        storeInfo: { ...job.basicInfo.storeInfo, storeId: index < 3 ? 100 : 101 + index },
      },
    }));
    const group = buildBrandNearestStoreSummary(jobs)![0];
    expect(group.totalStoreCount).toBe(3);
    expect(group.nearestStores.map((store) => store.jobId)).toEqual([1, 4, 5]);
    expect(renderMultiStoreBrandWarning([group])).toContain('共 3 家');
    expect(jobs).toHaveLength(5);
  });

  it('uses store ID rather than display name and separates name fallbacks by city and address', () => {
    const base = makeJob(1, '肯德基', 100, '万达店', 2, 22);
    const jobs = [
      {
        ...base,
        basicInfo: { ...base.basicInfo, storeInfo: { ...base.basicInfo.storeInfo, storeId: 11 } },
      },
      {
        ...base,
        basicInfo: {
          ...base.basicInfo,
          jobId: 2,
          storeInfo: { ...base.basicInfo.storeInfo, storeId: 12 },
        },
      },
      {
        ...base,
        basicInfo: {
          ...base.basicInfo,
          jobId: 3,
          storeInfo: { storeName: '万达店', storeCityName: '南京' },
        },
      },
      {
        ...base,
        basicInfo: {
          ...base.basicInfo,
          jobId: 4,
          storeInfo: { storeName: '万达店', storeCityName: '苏州' },
        },
      },
      {
        ...base,
        basicInfo: {
          ...base.basicInfo,
          jobId: 5,
          storeInfo: { storeName: '万达店', storeCityName: '苏州', storeAddress: '另一地址' },
        },
      },
    ];
    expect(buildBrandNearestStoreSummary(jobs)![0].totalStoreCount).toBe(5);
  });

  it('does not label multiple jobs at one store as multiple stores or infer stores from missing identity', () => {
    const first = makeJob(1, '成都你六姐', 10200, '太仓万达店', 1, 22);
    const second = makeJob(2, '成都你六姐', 10200, '太仓万达店', 1, 24);
    const groups = buildBrandNearestStoreSummary([first, second]);
    expect(groups![0].totalStoreCount).toBe(1);
    expect(renderMultiStoreBrandWarning(groups)).toBeNull();
    expect(
      buildBrandNearestStoreSummary([
        { basicInfo: { brandName: '成都你六姐', brandId: 10200, jobId: 3 } },
      ]),
    ).toBeNull();
  });
});

function makeJob(
  jobId: number,
  brandName: string,
  brandId: number,
  storeName: string,
  distanceKm: number,
  wage: number,
) {
  return {
    basicInfo: {
      brandName,
      brandId,
      jobId,
      storeInfo: {
        storeName,
        storeCityName: '上海',
      },
    },
    _distanceKm: distanceKm,
    jobSalary: {
      salaryScenarioList: [
        {
          comprehensiveSalary: {
            minComprehensiveSalary: wage,
            maxComprehensiveSalary: wage + 5,
            comprehensiveSalaryUnit: '元/时',
          },
        },
      ],
    },
  };
}
