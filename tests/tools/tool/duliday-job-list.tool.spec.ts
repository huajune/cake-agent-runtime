import { buildJobListTool } from '@tools/duliday-job-list.tool';
import { ToolBuildContext } from '@shared-types/tool.types';

describe('buildJobListTool', () => {
  const mockSpongeService = {
    fetchJobs: jest.fn(),
  };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'sess-1',
    messages: [],
  };

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const makeJobData = (overrides: any = {}) => ({
    basicInfo: {
      jobId: 1,
      brandName: 'KFC',
      jobName: '服务员',
      jobNickName: null,
      jobCategoryName: '餐饮',
      laborForm: '全职',
      jobContent: '负责前台服务',
      storeInfo: {
        storeName: '朝阳店',
        storeAddress: '北京市朝阳区xx路',
        storeCityName: '北京',
        storeRegionName: '朝阳区',
      },
      ...overrides.basicInfo,
    },
    jobSalary: overrides.jobSalary ?? null,
    welfare: overrides.welfare ?? null,
    hiringRequirement: overrides.hiringRequirement ?? null,
    workTime: overrides.workTime ?? null,
    interviewProcess: overrides.interviewProcess ?? null,
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const defaultInput = {
    cityNameList: [],
    regionNameList: [],
    brandAliasList: [],
    storeNameList: [],
    jobCategoryList: [],
    brandIdList: [],
    projectNameList: [],
    projectIdList: [],
    jobIdList: [],
    location: undefined as
      | {
          longitude?: number;
          latitude?: number;
          range?: number;
        }
      | undefined,
    responseFormat: ['markdown'] as ('markdown' | 'rawData')[],
    includeBasicInfo: true,
    includeJobSalary: false,
    includeWelfare: false,
    includeHiringRequirement: false,
    includeWorkTime: false,
    includeInterviewProcess: false,
  };

  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.useRealTimers());

  /* eslint-disable @typescript-eslint/no-explicit-any */
  const executeTool = async (ctx: ToolBuildContext = mockContext, input = defaultInput) => {
    const builder = buildJobListTool(mockSpongeService as never);
    const builtTool = builder(ctx);
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should describe schedule mismatch and multi-job formatting guardrails', () => {
    const builder = buildJobListTool(mockSpongeService as never);
    const builtTool = builder(mockContext);

    expect(builtTool.description).toContain('只周末');
    expect(builtTool.description).toContain('早开晚结全天时段/05:00-23:00');
    expect(builtTool.description).toContain('不得回复"周末能排"');
    expect(builtTool.description).toContain('推荐 2 个及以上岗位时');
    expect(builtTool.description).toContain('禁止把多个岗位压缩在同一句');
  });

  it('should return markdown format by default', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData()],
      total: 1,
    });

    const result = await executeTool();

    expect(result.markdown).toBeDefined();
    expect(result.markdown).toContain('KFC');
  });

  it('should return error when no jobs found', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

    const result = await executeTool();

    expect(result.error).toContain('未找到');
  });

  it('should block region-only queries when city is missing', async () => {
    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: [],
      regionNameList: ['徐汇'],
    });

    expect(result).toEqual({ error: '需要城市信息，只有区，无法查询' });
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('should call onJobsFetched callback', async () => {
    const job = makeJobData({
      jobSalary: {
        salaryScenarioList: [
          {
            comprehensiveSalary: {
              minComprehensiveSalary: 4000,
              maxComprehensiveSalary: 5000,
              comprehensiveSalaryUnit: '元/月',
            },
          },
        ],
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const onJobsFetched = jest.fn();
    const contextWithCallback = { ...mockContext, onJobsFetched };

    await executeTool(contextWithCallback);

    expect(onJobsFetched).toHaveBeenCalledWith([
      expect.objectContaining({
        jobId: 1,
        brandName: 'KFC',
        salaryDesc: '4000-5000 元/月',
      }),
    ]);
  });

  it('should include distance, store address and booking constraints in onJobsFetched summary', async () => {
    const job = makeJobData({
      basicInfo: {
        storeInfo: {
          storeName: '朝阳店',
          storeAddress: '北京市朝阳区xx路',
          storeCityName: '北京',
          storeRegionName: '朝阳区',
          longitude: 116.48,
          latitude: 39.94,
        },
      },
      hiringRequirement: {
        basicPersonalRequirements: { minAge: 18, maxAge: 35 },
        certificate: { education: '本科', healthCertificate: '需健康证' },
        remark: '不招学生',
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const onJobsFetched = jest.fn();
    const contextWithCallback = {
      ...mockContext,
      onJobsFetched,
      thresholds: [
        {
          flag: 'max_recommend_distance_km',
          label: '推荐距离上限',
          rule: '仅推荐距离范围内门店',
          max: 50,
          unit: 'km',
        },
      ],
    };

    await executeTool(contextWithCallback, {
      ...defaultInput,
      location: {
        latitude: 39.93,
        longitude: 116.47,
      },
    });

    expect(onJobsFetched).toHaveBeenCalledWith([
      expect.objectContaining({
        jobId: 1,
        storeAddress: '北京市朝阳区xx路',
        ageRequirement: '18-35岁',
        educationRequirement: '本科',
        healthCertificateRequirement: '需健康证',
        studentRequirement: '不接受学生',
        distanceKm: expect.any(Number),
      }),
    ]);
  });

  it('should handle SpongeService error', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool();

    expect(result.error).toContain('API timeout');
  });

  it('should prepend interview decision summary when requirement or interview flags are enabled', async () => {
    const job = makeJobData({
      hiringRequirement: {
        basicPersonalRequirements: { minAge: 18, maxAge: 40 },
        certificate: { healthCertificate: '食品健康证' },
        remark: '有分拣经验优先，能接受体力活',
      },
      interviewProcess: {
        interviewTotal: 1,
        firstInterview: {
          firstInterviewWay: '线下面试',
          interviewDemand: '提交报名信息需完整齐全',
        },
        remark: '没有健康证的需办加急，最迟1/31完成面试',
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeHiringRequirement: true,
      includeInterviewProcess: true,
    });

    expect(result.markdown).toContain('### 约面重点');
    expect(result.markdown).toContain('**年龄要求**: 18-40岁');
    expect(result.markdown).toContain('**健康证**: 食品健康证');
    expect(result.markdown).toContain('**关键要求**: 有分拣经验优先，能接受体力活');
    expect(result.markdown).toContain('**面试形式**: 线下面试');
    expect(result.markdown).toContain('**报名要求**: 提交报名信息需完整齐全');
    expect(result.markdown).toContain('**时效限制**: 没有健康证的需办加急');
  });

  it('should suppress clearly expired date constraints from interview highlights', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-03-30T08:00:00.000Z'));

    const job = makeJobData({
      hiringRequirement: {
        certificate: { healthCertificate: '食品健康证' },
      },
      interviewProcess: {
        firstInterview: {
          firstInterviewWay: '线下面试',
          interviewDemand: '提交报名信息需完整齐全',
        },
        remark: '有健康的最迟1/31面试完毕，2/1最后入职时间，过期不再办理入职；没有健康证的需办加急',
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeHiringRequirement: true,
      includeInterviewProcess: true,
    });

    expect(result.markdown).toContain('### 约面重点');
    expect(result.markdown).toContain('**时效限制**: 没有健康证的需办加急');
    expect(result.markdown).not.toContain('**时效限制**: 有健康的最迟1/31');
    expect(result.markdown).not.toContain('**时效限制**: 2/1最后入职时间');
  });

  it('should suppress stale spring festival constraints across requirement and work-time fields', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-04-01T02:00:00.000Z'));

    const job = makeJobData({
      hiringRequirement: {
        basicPersonalRequirements: { minAge: 18, maxAge: 40 },
        remark: '周四、六、日需要能给班，过年不返乡',
      },
      workTime: {
        employmentForm: '兼职',
        workTimeRemark: '每天8小时，过年不返乡',
      },
      interviewProcess: {
        firstInterview: {
          firstInterviewWay: '线下面试',
          interviewDemand: '能接受排班，过年不返乡',
        },
        remark: '年后返岗，面试前联系店长',
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeHiringRequirement: true,
      includeWorkTime: true,
      includeInterviewProcess: true,
    });

    expect(result.markdown).toContain('**其他要求**: 周四、六、日需要能给班');
    expect(result.markdown).toContain('**工时备注**: 每天8小时');
    expect(result.markdown).toContain('**面试备注**: 面试前联系店长');
    expect(result.markdown).not.toContain('过年不返乡');
    expect(result.markdown).not.toContain('年后返岗');
  });

  it('should render sections with merged semantic projection (no raw field tree, no projection block)', async () => {
    const job = makeJobData({
      basicInfo: {
        brandId: 10005,
        projectName: 'KFC 项目',
        projectId: 5,
        storeInfo: {
          storeId: 100,
          storeName: '朝阳店',
          storeAddress: '北京市朝阳区xx路',
          storeCityName: '北京',
          storeRegionName: '朝阳区',
          longitude: 116.1,
          latitude: 39.9,
        },
      },
      workTime: {
        employmentForm: '长期用工',
        minWorkMonths: 3,
        dayWorkTime: { perDayMinWorkHours: '3.0' },
        dailyShiftSchedule: { arrangementType: '固定排班制' },
        monthWorkTime: {
          perMonthMaxRestTime: 4,
          perMonthMaxRestTimeUnit: '天',
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      responseFormat: ['markdown'],
      includeBasicInfo: true,
      includeWorkTime: true,
    });

    // Sections exist
    expect(result.markdown).toContain('### 基本信息');
    expect(result.markdown).toContain('### 工作时间');

    // Merged semantic fields (new projection)
    expect(result.markdown).toContain('**品牌**: KFC (ID: 10005)');
    expect(result.markdown).toContain('**项目**: KFC 项目 (ID: 5)');
    expect(result.markdown).toContain('**门店**: 朝阳店 (ID: 100)');
    expect(result.markdown).toContain('**坐标**: 116.1, 39.9');
    expect(result.markdown).toContain('**最少工作月数**: 3 个月');
    expect(result.markdown).toContain('**每日工时**: 最少 3 小时');
    expect(result.markdown).toContain('**每月工时**: 最多休息 4 天');
    expect(result.markdown).toContain('**排班类型**: 固定排班制');

    // No legacy projection block artifacts
    expect(result.markdown).not.toContain('字段投影');
    expect(result.markdown).not.toContain('已省略未设置字段');
    expect(result.markdown).not.toContain('**门店信息 / 城市**');
    expect(result.markdown).not.toContain('未设置');
    expect(result.markdown).not.toContain('```json');
  });

  it('should hide null/empty fields and only render ones with values', async () => {
    const job = makeJobData({
      hiringRequirement: {
        basicPersonalRequirements: {
          genderRequirement: '男性,女性',
          minAge: 18,
          maxAge: 35,
        },
        certificate: {
          education: '不限',
          healthCertificate: null,
          certificates: null,
        },
        language: {
          languages: null,
          languageRemark: null,
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeHiringRequirement: true,
    });

    expect(result.markdown).toContain('### 招聘要求');
    expect(result.markdown).toContain('**性别**: 男性,女性');
    expect(result.markdown).toContain('**年龄**: 18-35 岁');
    expect(result.markdown).toContain('**学历**: 不限');
    // Null / empty fields must NOT appear
    expect(result.markdown).not.toContain('**健康证**');
    expect(result.markdown).not.toContain('**证件**');
    expect(result.markdown).not.toContain('**语言**');
    expect(result.markdown).not.toContain('**语言备注**');
    expect(result.markdown).not.toContain('字段投影');
    expect(result.markdown).not.toContain('已省略未设置字段');
  });

  it('should render combined arrangement schedule with compressed weekdays', async () => {
    const job = makeJobData({
      workTime: {
        dailyShiftSchedule: {
          arrangementType: '组合排班制',
          combinedArrangement: [
            {
              combinedArrangementWeekdays: '每周一,每周二,每周三,每周四,每周五,每周六,每周日',
              combinedArrangementStartTime: '09:00',
              combinedArrangementEndTime: '18:30',
            },
            {
              combinedArrangementWeekdays: '每周一,每周二,每周三,每周四,每周五,每周六,每周日',
              combinedArrangementStartTime: '13:00',
              combinedArrangementEndTime: '22:30',
            },
          ],
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeWorkTime: true,
    });

    expect(result.markdown).toContain('**排班类型**: 组合排班制');
    expect(result.markdown).toContain('**组合排班**');
    expect(result.markdown).toContain('班次 1: 09:00 - 18:30（每天）');
    expect(result.markdown).toContain('班次 2: 13:00 - 22:30（每天）');
    expect(result.markdown).toContain('**排班硬约束提示**');
    expect(result.markdown).toContain('不能把该岗位说成"周末能排"');
  });

  it('should render stair salary and periodic interview times for complex jobs', async () => {
    const job = makeJobData({
      jobSalary: {
        salaryScenarioList: [
          {
            salaryType: '正式',
            salaryPeriod: '月结算',
            payday: '15号',
            hasStairSalary: '有阶梯薪资',
            basicSalary: { basicSalary: 17, basicSalaryUnit: '元/时' },
            comprehensiveSalary: {
              minComprehensiveSalary: 3000,
              maxComprehensiveSalary: 6000,
              comprehensiveSalaryUnit: '元/月',
            },
            stairSalaries: [
              {
                description: '超出后所有工时按照新的薪资标准计算',
                perTimeUnit: '每月',
                fullWorkTime: 100,
                fullWorkTimeUnit: '小时',
                salary: 21,
                salaryUnit: '元/时',
              },
            ],
            holidaySalary: { holidaySalaryType: '无薪资' },
            overtimeSalary: { overtimeSalaryType: '无薪资' },
          },
        ],
      },
      interviewProcess: {
        interviewTotal: 1,
        firstInterview: {
          firstInterviewWay: '线上面试',
          interviewTimeMode: '周期',
          periodicInterviewTimes: [
            {
              interviewWeekday: '每周二',
              interviewTimes: [
                {
                  interviewStartTime: '10:00',
                  interviewEndTime: '15:00',
                  cycleDeadlineDay: '前一天',
                  cycleDeadlineEnd: '18:30',
                },
              ],
            },
          ],
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeJobSalary: true,
      includeInterviewProcess: true,
    });

    expect(result.markdown).toContain('#### 薪资方案 1（正式）');
    expect(result.markdown).toContain('**结算周期**: 月结算, 15号发薪');
    expect(result.markdown).toContain('**基础薪资**: 17 元/时');
    expect(result.markdown).toContain('**综合薪资**: 3000-6000 元/月');
    expect(result.markdown).toContain('**阶梯薪资**');
    expect(result.markdown).toContain('每月超过 100小时: 21 元/时');
    expect(result.markdown).toContain('**节假日薪资**: 无薪资');
    expect(result.markdown).toContain('**加班薪资**: 无薪资');
    expect(result.markdown).toContain('**一轮面试**');
    expect(result.markdown).toContain('**周期面试时间**');
    expect(result.markdown).toContain('每周二 10:00-15:00（报名截止: 前一天 18:30）');
  });

  it('should scan additional pages before distance filtering to reduce first-page bias', async () => {
    const makeGeoJob = (id: number, latitude: number, longitude: number) =>
      makeJobData({
        basicInfo: {
          jobId: id,
          storeInfo: {
            storeId: id,
            storeName: `门店${id}`,
            storeAddress: `上海市浦东新区测试路${id}号`,
            storeCityName: '上海',
            storeRegionName: '浦东新区',
            latitude,
            longitude,
          },
        },
      });

    const farJobs = Array.from({ length: 19 }, (_, index) =>
      makeGeoJob(2 + index, 31.5 + index * 0.001, 121.3 + index * 0.001),
    );
    const secondPageFarJobs = Array.from({ length: 19 }, (_, index) =>
      makeGeoJob(22 + index, 31.45 + index * 0.001, 121.25 + index * 0.001),
    );

    mockSpongeService.fetchJobs
      .mockResolvedValueOnce({
        jobs: [makeGeoJob(1, 31.1856, 121.6981), ...farJobs],
        total: 40,
      })
      .mockResolvedValueOnce({
        jobs: [makeGeoJob(21, 31.1849, 121.6976), ...secondPageFarJobs],
        total: 40,
      });

    const contextWithThresholds: ToolBuildContext = {
      ...mockContext,
      thresholds: [
        {
          flag: 'max_recommend_distance_km',
          label: '推荐距离上限',
          rule: '仅推荐距离范围内门店',
          max: 10,
          unit: 'km',
        },
      ],
    };

    const result = await executeTool(contextWithThresholds, {
      ...defaultInput,
      location: {
        latitude: 31.185104,
        longitude: 121.697948,
      },
      responseFormat: ['rawData'],
    });

    const rawData = result.rawData as { result: Array<{ basicInfo?: { jobId?: number } }>; total: number };
    const nearJobIds = rawData.result.map((job) => job.basicInfo?.jobId);

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(rawData.total).toBe(2);
    expect(nearJobIds).toEqual(expect.arrayContaining([1, 21]));
    expect(result.queryMeta.distanceThresholdKm).toBe(10);
    expect(result.queryMeta.distanceScanPages).toBe(2);
    expect(result.queryMeta.distanceScanTruncated).toBe(false);
  });

  describe('multi-store same-brand rendering (badcase laybqxn4)', () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const makeKfcJob = (jobId: number, storeName: string, distanceKm: number, wage: number) =>
      ({
        ...makeJobData({
          basicInfo: {
            jobId,
            brandId: 100,
            brandName: '肯德基',
            storeInfo: { storeName, storeAddress: '上海市虹桥', storeCityName: '上海' },
          },
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
        }),
        _distanceKm: distanceKm,
      }) as any;
    /* eslint-enable @typescript-eslint/no-explicit-any */

    it('emits ⚠️ 同品牌多门店 section in markdown when ≥2 stores share a brand', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeKfcJob(1, '绿地缤纷城店', 2.3, 17),
          makeKfcJob(2, '日月光店', 5.1, 17),
        ],
        total: 2,
      });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        location: { latitude: 31.21, longitude: 121.29 },
      });

      const md = result.markdown as string;
      expect(md).toContain('⚠️ 同品牌多门店');
      expect(md).toContain('肯德基（绿地缤纷城店，2.3km，17-22 元/时）');
      expect(md).toContain('肯德基（日月光店，5.1km，17-22 元/时）');
      expect(md).toContain('jobId: 1');
      expect(md).toContain('jobId: 2');
    });

    it('exposes multiStoreSameBrandGroups in queryMeta', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [makeKfcJob(1, '绿地缤纷城店', 2.3, 17), makeKfcJob(2, '日月光店', 5.1, 17)],
        total: 2,
      });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        location: { latitude: 31.21, longitude: 121.29 },
      });

      expect(result.queryMeta.multiStoreSameBrandGroups).toEqual([
        expect.objectContaining({
          brandName: '肯德基',
          totalStoreCount: 2,
          requiresStoreDifferentiation: true,
          displayLines: [
            '肯德基（绿地缤纷城店，2.3km，17-22 元/时）',
            '肯德基（日月光店，5.1km，17-22 元/时）',
          ],
        }),
      ]);
    });

    it('does not emit warning section when each brand has only 1 store', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeKfcJob(1, '绿地缤纷城店', 2.3, 17),
          {
            ...makeJobData({
              basicInfo: {
                jobId: 2,
                brandId: 200,
                brandName: '麦当劳',
                storeInfo: { storeName: '徐汇店', storeCityName: '上海' },
              },
            }),
            _distanceKm: 3.0,
          },
        ],
        total: 2,
      });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        location: { latitude: 31.21, longitude: 121.29 },
      });

      const md = result.markdown as string;
      expect(md).not.toContain('⚠️ 同品牌多门店');
      expect(result.queryMeta.multiStoreSameBrandGroups).toBeNull();
    });
  });
});
