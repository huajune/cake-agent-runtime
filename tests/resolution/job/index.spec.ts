import {
  extractPresentedJobs,
  findStoreReferencedJobs,
  pickBestReferencedJob,
  resolveAssistantAnchoredFocusJob,
  resolveCurrentFocusJob,
} from '@resolution/job';
import type { RecommendedJobSummary } from '@resolution/job/types';

describe('resolution/job', () => {
  const chaoneiJob: RecommendedJobSummary = {
    jobId: 526626,
    brandName: '必胜客',
    jobName: '服务员',
    storeName: '朝内店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '20元/小时',
    jobCategoryName: '餐饮/中餐/普通服务员',
  };

  const dongdanJob: RecommendedJobSummary = {
    jobId: 526627,
    brandName: '必胜客',
    jobName: '服务员',
    storeName: '东单店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '20元/小时',
    jobCategoryName: '餐饮/中餐/普通服务员',
  };

  const retailJob: RecommendedJobSummary = {
    jobId: 526628,
    brandName: '全家',
    jobName: '门店岗位',
    storeName: '建国门店',
    cityName: '北京',
    regionName: '东城区',
    laborForm: '兼职',
    salaryDesc: '18元/小时',
    jobCategoryName: '零售/便利店/店员',
  };

  it('matches the actual store name after city, owner and store-code normalization', () => {
    const coded = { ...chaoneiJob, cityName: '佛山市', storeName: '佛山-李苑雯-幸福里DT-GZ7001' };
    expect(resolveCurrentFocusJob('幸福里那家', [], [], [coded, dongdanJob])).toEqual(coded);
    expect(pickBestReferencedJob([coded, dongdanJob], '幸福里发个定位', 'store')).toEqual(coded);
    expect(findStoreReferencedJobs([coded], '佛山李苑雯GZ7001')).toEqual([]);
    expect(findStoreReferencedJobs([coded, dongdanJob], '服务员20元每小时')).toEqual([]);
  });

  it('keeps same-name stores ambiguous and uses an explicit brand to distinguish them', () => {
    const otherBrand = { ...chaoneiJob, jobId: 200, brandName: '肯德基' };
    expect(pickBestReferencedJob([chaoneiJob, otherBrand], '朝内店地址', 'store')).toBeNull();
    expect(pickBestReferencedJob([chaoneiJob, otherBrand], '肯德基朝内店地址', 'store')).toEqual(
      otherBrand,
    );
  });

  it('展示记录剔除仅作为更长店名子串命中的短别名，不挤掉实际展示岗', () => {
    const shortJobs = [1, 2, 3].map((jobId) => ({ ...chaoneiJob, jobId, storeName: '万达店' }));
    const fullName = { ...dongdanJob, storeName: '万达广场店' };
    expect(extractPresentedJobs('万达广场店可以', [...shortJobs, fullName])).toEqual([fullName]);
    expect(extractPresentedJobs('万达店、万达广场店都可以', [shortJobs[0], fullName])).toEqual([
      shortJobs[0],
      fullName,
    ]);
  });

  it('should extract presented jobs from assistant reply', () => {
    expect(
      extractPresentedJobs('离你最近的是朝内店，东单店也可以。', [chaoneiJob, dongdanJob]),
    ).toEqual([chaoneiJob, dongdanJob]);
  });

  it('keeps conflicting explicit brand and store references ambiguous', () => {
    const otherBrand = { ...dongdanJob, brandName: '肯德基' };
    expect(pickBestReferencedJob([chaoneiJob, otherBrand], '肯德基朝内店地址', 'store')).toBeNull();
    expect(findStoreReferencedJobs([chaoneiJob, otherBrand], '肯德基朝内店地址')).toHaveLength(2);
  });

  it('独立点名的长短店名都参与歧义判断，不能默认选择长店名', () => {
    const longer = { ...dongdanJob, storeName: '东方广场店' };
    const message = '不要东方广场店，发朝内店定位';
    expect(findStoreReferencedJobs([longer, chaoneiJob], message)).toEqual([longer, chaoneiJob]);
    expect(pickBestReferencedJob([longer, chaoneiJob], message, 'store')).toBeNull();
  });

  it('prefers a complete store name over another store’s shorter alias', () => {
    const shortName = { ...chaoneiJob, storeName: '万达店' };
    const fullName = { ...dongdanJob, storeName: '万达广场店' };
    expect(pickBestReferencedJob([shortName, fullName], '万达广场店地址', 'store')).toEqual(
      fullName,
    );
  });

  it.each([true, false])('焦点选择使用完整门店名，短别名已展示=%s', (presentedShort) => {
    const shortName = { ...chaoneiJob, storeName: '万达店' };
    const fullName = { ...dongdanJob, storeName: '万达广场店' };
    expect(pickBestReferencedJob([shortName, fullName], '万达广场店')).toEqual(fullName);
    expect(
      resolveCurrentFocusJob(
        '我选万达广场店',
        presentedShort ? [shortName] : [fullName, shortName],
        [],
        [shortName, fullName],
      ),
    ).toEqual(fullName);
    expect(pickBestReferencedJob([shortName, { ...shortName, jobId: 999 }], '万达店')).toBeNull();
  });

  it('should resolve focus job when user explicitly picks a store', () => {
    expect(resolveCurrentFocusJob('我选朝内店', [chaoneiJob, dongdanJob], [], [])).toEqual(
      chaoneiJob,
    );
  });

  it('should clear focus job when user asks to switch batch', () => {
    expect(resolveCurrentFocusJob('再看看别的', [chaoneiJob], [], [])).toBeNull();
  });

  it('should keep original focus when no clear signal is found', () => {
    expect(resolveCurrentFocusJob('我再想想', [chaoneiJob, dongdanJob], [], [])).toBeUndefined();
  });

  it('should select the only presented job when focus intent is generic', () => {
    expect(resolveCurrentFocusJob('就这家吧', [chaoneiJob], [], [])).toEqual(chaoneiJob);
  });

  it('should match hierarchical jobCategoryName segments when user describes a role', () => {
    expect(
      resolveCurrentFocusJob('我想去零售店员那个岗位', [], [], [chaoneiJob, retailJob]),
    ).toEqual(retailJob);
  });

  it('should derive focus job from assistant template when one job is clearly dominant', () => {
    const jiangwanDailyJob: RecommendedJobSummary = {
      jobId: 527487,
      brandName: '肯德基',
      jobName: '肯德基-江湾字节T4-日结-小时工',
      storeName: '江湾字节T4',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '兼职',
      salaryDesc: '24元/小时',
      jobCategoryName: '日结小时工',
    };

    const jiangwanHybridJob: RecommendedJobSummary = {
      jobId: 527488,
      brandName: '肯德基',
      jobName: '肯德基-江湾字节T4-月结-全职',
      storeName: '江湾字节T4',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '全职',
      salaryDesc: '17元/小时起',
      jobCategoryName: '月结全职',
    };

    const youfangDailyJob: RecommendedJobSummary = {
      jobId: 527489,
      brandName: '肯德基',
      jobName: '肯德基-杨浦悠方-日结-小时工',
      storeName: '杨浦悠方',
      cityName: '上海',
      regionName: '杨浦',
      laborForm: '兼职',
      salaryDesc: '24元/小时',
      jobCategoryName: '日结小时工',
    };

    const assistantTemplate =
      '面试要求：先将以下资料补充下发给我，我来帮你约面试 姓名： 联系方式： 性别： 年龄： 面试时间： 应聘门店：江湾字节T4 应聘岗位：肯德基-江湾字节T4-日结-小时工';

    expect(
      resolveAssistantAnchoredFocusJob(
        assistantTemplate,
        [jiangwanDailyJob, jiangwanHybridJob],
        [],
        [jiangwanDailyJob, jiangwanHybridJob, youfangDailyJob],
      ),
    ).toEqual(jiangwanDailyJob);
  });

  describe('唯一岗自动锁焦（badcase chat 6a62c6f8：单岗展示打分不足焦点悬空）', () => {
    // 生产展示话术只含 门店(+5)+品牌(+1)+薪资(+1)=7 分，够不到 8 分门槛
    const singleJobReply =
      '呼和浩特这边有咱们合作的门店，刚帮你查到一个：肯德基（金地明峰）- 服务员，约5.6km，薪资：13.04元/时起，综合2500-3200元/月';

    const kfcJob: RecommendedJobSummary = {
      jobId: 528527,
      brandName: '肯德基',
      jobName: '餐饮/西餐厅/普通服务员',
      storeName: '金地明峰',
      cityName: '呼和浩特市',
      regionName: '新城区',
      laborForm: '兼职',
      salaryDesc: '2500-3200 元/月',
      jobCategoryName: '餐饮/西餐厅/普通服务员',
    };

    it('locks focus when the pool and presented list contain the same single job', () => {
      expect(resolveAssistantAnchoredFocusJob(singleJobReply, [], [kfcJob], [kfcJob])).toEqual(
        kfcJob,
      );
    });

    it('does not auto-lock when the pool has other candidates', () => {
      expect(
        resolveAssistantAnchoredFocusJob(singleJobReply, [], [kfcJob], [kfcJob, chaoneiJob]),
      ).toBeNull();
    });
  });
});
