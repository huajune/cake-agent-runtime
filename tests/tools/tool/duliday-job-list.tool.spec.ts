import { buildJobListTool } from '@tools/duliday-job-list.tool';
import { ToolBuildContext } from '@shared-types/tool.types';
import { TOOL_ERROR_TYPES } from '@tools/types/tool-error-types';

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
    const builder = buildJobListTool(
      mockSpongeService as never,
      { recordEvent: jest.fn() } as never,
      { geocode: jest.fn().mockResolvedValue(null) } as never,
    );
    const builtTool = builder(ctx);
    return builtTool.execute(input as any, {
      toolCallId: 'test',
      messages: [],
      abortSignal: undefined as any,
    }) as any;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  it('should describe schedule mismatch and multi-job formatting guardrails', () => {
    const builder = buildJobListTool(
      mockSpongeService as never,
      { recordEvent: jest.fn() } as never,
      { geocode: jest.fn().mockResolvedValue(null) } as never,
    );
    const builtTool = builder(mockContext);

    expect(builtTool.description).toContain('只周末');
    expect(builtTool.description).toContain('早开晚结全天时段/05:00-23:00');
    expect(builtTool.description).toContain('不得回复"周末能排"');
    expect(builtTool.description).toContain('推荐 2 个及以上岗位时');
    expect(builtTool.description).toContain('禁止把多个岗位压缩在同一句');
    expect(builtTool.description).toContain('年龄判断必须沿用 precheck 弹性口径');
    expect(builtTool.description).toContain('候选人 52 岁遇到 20-50 岁 / 40-50 岁岗位');
    expect(builtTool.description).toContain('福利追问必须用 jobId 实时重查');
    expect(builtTool.description).toContain('记忆只用于定位 jobId，禁止直接据记忆回答');
  });

  it('should annotate candidate age boundary results instead of leaving the model to strict-filter ages', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJobData({
          basicInfo: {
            jobId: 1,
            brandName: '史伟莎',
            jobName: '消杀员',
            storeInfo: {
              storeName: '长宁店',
              storeAddress: '上海市长宁区xx路',
              storeCityName: '上海',
              storeRegionName: '长宁区',
            },
          },
          hiringRequirement: {
            basicPersonalRequirements: { minAge: 20, maxAge: 50 },
          },
        }),
        makeJobData({
          basicInfo: {
            jobId: 2,
            brandName: '奥乐齐',
            jobName: '理货员',
            storeInfo: {
              storeName: '缤谷广场',
              storeAddress: '上海市长宁区xx路',
              storeCityName: '上海',
              storeRegionName: '长宁区',
            },
          },
          hiringRequirement: {
            basicPersonalRequirements: { minAge: 18, maxAge: 45 },
          },
        }),
      ],
      total: 2,
    });

    const result = await executeTool(
      {
        ...mockContext,
        sessionFacts: { interview_info: { age: '52' } } as ToolBuildContext['sessionFacts'],
      },
      {
        ...defaultInput,
        includeHiringRequirement: true,
      },
    );

    expect(result.markdown).toContain('## 候选人年龄筛选提示');
    expect(result.markdown).toContain('boundary 1 个');
    expect(result.markdown).toContain('hard_reject 1 个');
    expect(result.markdown).toContain('禁止回复"没有一个接受 52 岁"');
    expect(result.queryMeta.ageScreening).toEqual(
      expect.objectContaining({
        candidateAge: 52,
        counts: expect.objectContaining({
          boundary: 1,
          hard_reject: 1,
        }),
      }),
    );
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

  it('should not auto-apply session brand_ids when brandIdList is omitted (model decides)', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [
        makeJobData({
          basicInfo: {
            brandId: 10239,
            brandName: 'Levis',
          },
        }),
      ],
      total: 1,
    });

    const result = await executeTool(
      {
        ...mockContext,
        sessionFacts: {
          interview_info: {},
          preferences: { brand_ids: [10239] },
          reasoning: '',
        } as ToolBuildContext['sessionFacts'],
      },
      {
        ...defaultInput,
        cityNameList: ['昆明'],
      },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandIdList: [] }),
    );
    expect(result.queryMeta.brandIdList).toEqual([]);
  });

  it('should inject contact-remark brand into brandAliasList when model passes no brand', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData({ basicInfo: { brandName: 'KFC' } })],
      total: 1,
    });

    const result = await executeTool(
      { ...mockContext, contactBrandAliases: ['KFC'] },
      { ...defaultInput, cityNameList: ['上海'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: ['KFC'] }),
    );
    expect(result.queryMeta.brandAliasList).toEqual(['KFC']);
    expect(result.queryMeta.brandAliasSource).toBe('contact_remark');
  });

  it('should fall back to session-facts brands when model and remark carry no brand (badcase recvjFFKcZPsiC)', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData({ basicInfo: { brandName: '大米先生' } })],
      total: 1,
    });

    const result = await executeTool(
      {
        ...mockContext,
        sessionFacts: {
          preferences: { brands: ['大米先生'] },
        } as ToolBuildContext['sessionFacts'],
      },
      { ...defaultInput, cityNameList: ['南京'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: ['大米先生'] }),
    );
    expect(result.queryMeta.brandAliasSource).toBe('session_facts');
  });

  it('should prefer contact-remark brand over session-facts brands', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData({ basicInfo: { brandName: 'KFC' } })],
      total: 1,
    });

    const result = await executeTool(
      {
        ...mockContext,
        contactBrandAliases: ['KFC'],
        sessionFacts: {
          preferences: { brands: ['大米先生'] },
        } as ToolBuildContext['sessionFacts'],
      },
      { ...defaultInput, cityNameList: ['上海'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: ['KFC'] }),
    );
    expect(result.queryMeta.brandAliasSource).toBe('contact_remark');
  });

  it('should NOT override an explicitly passed brand with the contact-remark brand', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData({ basicInfo: { brandName: 'KFC' } })],
      total: 1,
    });

    const result = await executeTool(
      { ...mockContext, contactBrandAliases: ['星巴克'] },
      { ...defaultInput, cityNameList: ['上海'], brandAliasList: ['KFC'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: ['KFC'] }),
    );
    expect(result.queryMeta.brandAliasSource).toBe('input');
  });

  it('rejects a model brand copied from an unverified nickname unless the user said it', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({
      jobs: [makeJobData({ basicInfo: { brandName: 'KFC' } })],
      total: 1,
    });

    const result = await executeTool(
      {
        ...mockContext,
        contactName: 'Gattouzo',
        contactBrandAliases: [],
        currentUserMessage: '[位置分享] 上海松江',
      },
      { ...defaultInput, cityNameList: ['上海'], brandAliasList: ['Gattouzo'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: [] }),
    );
    expect(result.queryMeta.brandAliasSource).toBe('none');
    expect(result.queryMeta.rejectedNicknameBrandAliases).toEqual(['Gattouzo']);
  });

  it('keeps an unknown brand when the candidate explicitly names it in the current message', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

    await executeTool(
      {
        ...mockContext,
        contactName: 'Gattouzo',
        contactBrandAliases: [],
        currentUserMessage: 'Gattouzo 还招人吗',
      },
      { ...defaultInput, cityNameList: ['上海'], brandAliasList: ['Gattouzo'] },
    );

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({ brandAliasList: ['Gattouzo'] }),
    );
  });

  it('should return error when no jobs found', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

    const result = await executeTool();

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
    expect(result._replyInstruction).toContain('invite_to_group');
  });

  it('should block region-only queries when city is missing', async () => {
    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: [],
      regionNameList: ['徐汇'],
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT);
    expect(result._replyInstruction).toContain('城市');
    expect(result._replyInstruction).not.toMatch(/上海|北京|杭州|成都/);
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('should block store-only queries when city and coordinates are missing', async () => {
    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: [],
      storeNameList: ['人民广场店'],
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT);
    expect(mockSpongeService.fetchJobs).not.toHaveBeenCalled();
  });

  it('should allow region queries when coordinates are provided', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: [],
      regionNameList: ['徐汇'],
      location: { longitude: 121.45, latitude: 31.18 },
    });

    expect(result.errorType).not.toBe(TOOL_ERROR_TYPES.JOB_LIST_MISSING_CITY_CONTEXT);
    expect(mockSpongeService.fetchJobs).toHaveBeenCalled();
  });

  it('should derive location.range from max_recommend_distance_km when caller omits range', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJobData()], total: 1 });
    const ctx: ToolBuildContext = {
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

    await executeTool(ctx, {
      ...defaultInput,
      cityNameList: ['上海'],
      location: { longitude: 121.46, latitude: 31.18 },
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { longitude: 121.46, latitude: 31.18, range: 10000 },
      }),
    );
  });

  it('should keep explicit location.range untouched even when threshold exists', async () => {
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [makeJobData()], total: 1 });
    const ctx: ToolBuildContext = {
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

    await executeTool(ctx, {
      ...defaultInput,
      cityNameList: ['上海'],
      location: { longitude: 121.46, latitude: 31.18, range: 3000 },
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        location: { longitude: 121.46, latitude: 31.18, range: 3000 },
      }),
    );
  });

  it('normalizes Yanji to Sponge prefecture city and region even without coordinates', async () => {
    const yanjiJob = makeJobData({
      basicInfo: {
        jobId: 528176,
        brandName: '必胜客',
        jobName: '必胜客-延吉万达店-小时工',
        storeInfo: {
          storeName: '延吉万达店',
          storeAddress: '延河西路6999号延吉万达广场',
          storeCityName: '延边朝鲜族自治州',
          storeRegionName: '延吉市',
          latitude: 42.906,
          longitude: 129.471,
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValueOnce({ jobs: [yanjiJob], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: ['延吉'],
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(1);
    expect(mockSpongeService.fetchJobs.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        cityNameList: ['延边朝鲜族自治州'],
        regionNameList: ['延吉市'],
      }),
    );
    expect(result.resultCount).toBe(1);
    expect(result.markdown).toContain('延吉万达店');
    expect(result.queryMeta.cityFilterNormalization).toEqual([
      {
        requestedCity: '延吉',
        spongeCity: '延边朝鲜族自治州',
        spongeRegion: '延吉市',
      },
    ]);
    expect(result.queryMeta.cityFilterRecovery).toBeNull();
  });

  it('keeps county-level city normalization in the job-category local fallback', async () => {
    const yanjiJob = makeJobData({
      basicInfo: {
        jobId: 528177,
        brandName: '必胜客',
        jobName: '必胜客-延吉万达店-服务员-小时工',
        jobCategoryName: '服务员',
        storeInfo: {
          storeName: '延吉万达店',
          storeAddress: '延河西路6999号延吉万达广场',
          storeCityName: '延边朝鲜族自治州',
          storeRegionName: '延吉市',
        },
      },
    });
    mockSpongeService.fetchJobs
      .mockResolvedValueOnce({ jobs: [], total: 0 })
      .mockResolvedValueOnce({ jobs: [yanjiJob], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: ['延吉'],
      jobCategoryList: ['服务员'],
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(mockSpongeService.fetchJobs.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        cityNameList: ['延边朝鲜族自治州'],
        regionNameList: ['延吉市'],
        jobCategoryList: [],
      }),
    );
    expect(result.resultCount).toBe(1);
    expect(result.queryMeta.jobCategoryMatchStrategy).toBe('local_keyword_match');
  });

  it('recovers an unmapped county-level city from coordinates without adopting neighboring cities', async () => {
    const kunshanJob = makeJobData({
      basicInfo: {
        jobId: 98,
        storeInfo: {
          storeName: '昆山店',
          storeCityName: '苏州市',
          storeRegionName: '昆山市',
          latitude: 31.2,
          longitude: 121.0,
        },
      },
    });
    mockSpongeService.fetchJobs
      .mockResolvedValueOnce({ jobs: [], total: 0 })
      .mockResolvedValueOnce({ jobs: [kunshanJob], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: ['昆山'],
      location: { longitude: 121.0, latitude: 31.2, range: 10000 },
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(mockSpongeService.fetchJobs.mock.calls[1][0]).toEqual(
      expect.objectContaining({ cityNameList: [] }),
    );
    expect(result.resultCount).toBe(1);
    expect(result.queryMeta.cityFilterRecovery).toEqual({
      attempted: true,
      applied: true,
      requestedCities: ['昆山'],
      candidateCount: 1,
      recoveredCount: 1,
    });
  });

  it('does not adopt cross-city jobs from coordinate recovery when the city label does not match', async () => {
    const kunshanJob = makeJobData({
      basicInfo: {
        jobId: 99,
        storeInfo: {
          storeName: '昆山店',
          storeCityName: '苏州市',
          storeRegionName: '昆山市',
          latitude: 31.2,
          longitude: 121.0,
        },
      },
    });
    mockSpongeService.fetchJobs
      .mockResolvedValueOnce({ jobs: [], total: 0 })
      .mockResolvedValueOnce({ jobs: [kunshanJob], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: ['上海'],
      location: { longitude: 121.0, latitude: 31.2, range: 10000 },
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
    expect(result.cityFilterRecovery).toEqual({
      attempted: true,
      applied: false,
      requestedCities: ['上海'],
      candidateCount: 1,
      recoveredCount: 0,
    });
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

  it('should keep explicit meal and accommodation facts in the compact job summary', async () => {
    const job = makeJobData({
      welfare: {
        catering: '无餐饮福利',
        accommodation: '无住宿福利',
        trafficAllowanceSalary: 200,
        promotionWelfare: '表现优秀可晋升',
        otherWelfare: ['法定节假日三薪'],
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const onJobsFetched = jest.fn();
    await executeTool({ ...mockContext, onJobsFetched }, { ...defaultInput, includeWelfare: true });

    expect(onJobsFetched).toHaveBeenCalledWith([
      expect.objectContaining({
        jobId: 1,
        welfareFacts: {
          meals: 'self_or_none',
          accommodation: 'self_or_none',
          hasTrafficAllowance: true,
          hasPromotionWelfare: true,
          otherWelfareItems: ['法定节假日三薪'],
        },
      }),
    ]);
  });

  it('should handle SpongeService error', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool();

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_FETCH_FAILED);
    expect(result.reason).toBe('API timeout');
    expect(result._replyInstruction).not.toContain('API timeout');
  });

  it('does not fall back to historical non-summer jobs when a summer-worker query fails', async () => {
    mockSpongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

    const result = await executeTool({
      ...mockContext,
      sessionFacts: {
        interview_info: {},
        preferences: { labor_form: '暑假工' },
      } as ToolBuildContext['sessionFacts'],
    });

    expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_FETCH_FAILED);
    expect(result._replyInstruction).toContain('候选人已明确只要暑假工');
    expect(result._replyInstruction).toContain('不得基于 [会话记忆] 的普通兼职/小时工/全职岗位');
    expect(result._replyInstruction).toContain('不得推荐、收资或约面');
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
        weekAndMonthWorkTime: {
          arrangementCycleType: '每月',
          onWorkLimitType: '至多上岗',
          onWorkTimeUnit: '天',
          onWorkTime: 26,
        },
        dayWorkTime: {
          arrangementType: '满足其中一个时段即可安排上岗',
          combinedArrangement: [
            { combinedArrangementStartTime: '11:00', combinedArrangementEndTime: '14:00' },
          ],
          fixedTime: { perDayMinWorkHours: '3.0' },
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
    expect(result.markdown).toContain('**排班周期**: 每月: 至多上岗 26 天');
    expect(result.markdown).toContain('**排班类型**: 满足其中一个时段即可安排上岗');

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

  it('should render 组合排班(满足所有时段) slots + full-week hint', async () => {
    const job = makeJobData({
      workTime: {
        weekAndMonthWorkTime: {
          arrangementCycleType: '每周',
          weekMonthArrangementMode: '做几休几',
          perWeekWorkDays: 7,
          perWeekRestDays: 0,
        },
        dayWorkTime: {
          arrangementType: '满足所有时段才可安排上岗',
          combinedArrangement: [
            { combinedArrangementStartTime: '09:00', combinedArrangementEndTime: '18:30' },
            { combinedArrangementStartTime: '13:00', combinedArrangementEndTime: '22:30' },
          ],
          fixedTime: null,
        },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      includeWorkTime: true,
    });

    expect(result.markdown).toContain('**排班类型**: 满足所有时段才可安排上岗');
    expect(result.markdown).toContain('**可排时段**');
    expect(result.markdown).toContain('时段 1: 09:00 - 18:30');
    expect(result.markdown).toContain('时段 2: 13:00 - 22:30');
    // 组合排班制 → 全部出勤；perWeekWorkDays=7 → 全周强排班
    expect(result.markdown).toContain('**班次硬约束提示**');
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

    const rawData = result.rawData as {
      result: Array<{ basicInfo?: { jobId?: number } }>;
      total: number;
    };
    const nearJobIds = rawData.result.map((job) => job.basicInfo?.jobId);

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(2);
    expect(rawData.total).toBe(2);
    expect(nearJobIds).toEqual(expect.arrayContaining([1, 21]));
    expect(result.queryMeta.distanceThresholdKm).toBe(10);
    expect(result.queryMeta.distanceScanPages).toBe(2);
    expect(result.queryMeta.distanceScanTruncated).toBe(false);
  });

  it('should keep base filters when store-name fuzzy fallback re-queries (badcase 6a266b51536c9654027cbf40)', async () => {
    const storeJob = makeJobData({
      basicInfo: {
        jobId: 7,
        brandName: '成都你六姐',
        storeInfo: {
          storeName: '上海宝山正大乐城店',
          storeAddress: '上海市宝山区陆翔路111号',
          storeCityName: '上海',
          storeRegionName: '宝山区',
        },
      },
    });
    mockSpongeService.fetchJobs
      .mockResolvedValueOnce({ jobs: [], total: 0 })
      .mockResolvedValueOnce({ jobs: [storeJob], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      cityNameList: ['上海'],
      regionNameList: ['宝山'],
      brandAliasList: ['成都你六姐'],
      storeNameList: ['正大乐城'],
    });

    expect(mockSpongeService.fetchJobs).toHaveBeenCalledTimes(2);
    // 上游要求至少一个筛选条件：回退查询必须保留城市/品牌等范围筛选，只去掉门店名
    const fallbackParams = mockSpongeService.fetchJobs.mock.calls[1][0];
    expect(fallbackParams.cityNameList).toEqual(['上海']);
    expect(fallbackParams.regionNameList).toEqual(['宝山']);
    expect(fallbackParams.brandAliasList).toEqual(['成都你六姐']);
    expect(fallbackParams.storeNameList).toEqual([]);
    expect(result.queryMeta.storeMatchStrategy).toBe('local_fuzzy_match');
    expect(result.resultCount).toBe(1);
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
        jobs: [makeKfcJob(1, '绿地缤纷城店', 2.3, 17), makeKfcJob(2, '日月光店', 5.1, 17)],
        total: 2,
      });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        location: { latitude: 31.21, longitude: 121.29 },
      });

      const md = result.markdown as string;
      expect(md).toContain('⚠️ 同品牌多门店');
      expect(md).toContain('肯德基 餐饮（绿地缤纷城店，2.3km，17-22 元/时）');
      expect(md).toContain('肯德基 餐饮（日月光店，5.1km，17-22 元/时）');
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
            '肯德基 餐饮（绿地缤纷城店，2.3km，17-22 元/时）',
            '肯德基 餐饮（日月光店，5.1km，17-22 元/时）',
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

  describe('brand alias 同音回指 (badcase batch_6a0c074c536c9654029b6930)', () => {
    it('high confidence 单一匹配：候选人说"刘姐妹"实指上轮"成都你六姐"，工具回指并指示直接沿用', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const ctxWithRecentBrands: ToolBuildContext = {
        ...mockContext,
        recentBrandPool: ['成都你六姐', '奥乐齐'],
      };

      const result = await executeTool(ctxWithRecentBrands, {
        ...defaultInput,
        cityNameList: ['上海'],
        brandAliasList: ['刘姐妹'],
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
      expect(result._outcome).toContain('已自动回指');
      expect(result.aliasFuzzyMatch).not.toBeNull();
      expect(result.aliasFuzzyMatch.confidence).toBe('high');
      expect(result.aliasFuzzyMatch.suggestions[0].brandName).toBe('成都你六姐');
      expect(result.aliasFuzzyMatch.suggestions[0].sharedChars).toEqual(['姐']);
      expect(result._replyInstruction).toContain('直接按该品牌继续推进');
      // 高置信分支必须明确禁止 invite_to_group 拉群（语义检查："不要...invite_to_group"）
      expect(result._replyInstruction).toMatch(/不要[^。]*invite_to_group/);
      expect(result._replyInstruction).toContain('成都你六姐');
    });

    it('low confidence 多个相近匹配（分数完全相同）：要求反问澄清', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      // "肯德" 同时对"肯德基"和"肯德乐"得满分（共享[肯,德]+共享拼音[ken,de]）
      // → 两个候选 score 都=1，margin=0 < 0.15 → low confidence
      const ctxWithAmbiguousBrands: ToolBuildContext = {
        ...mockContext,
        recentBrandPool: ['肯德基', '肯德乐'],
      };

      const result = await executeTool(ctxWithAmbiguousBrands, {
        ...defaultInput,
        cityNameList: ['上海'],
        brandAliasList: ['肯德'],
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
      expect(result.aliasFuzzyMatch).not.toBeNull();
      expect(result.aliasFuzzyMatch.confidence).toBe('low');
      expect(result.aliasFuzzyMatch.suggestions).toHaveLength(2);
      expect(result._replyInstruction).toContain('反问澄清');
      expect(result._replyInstruction).not.toContain('直接按该品牌继续推进');
    });

    it('no fuzzy match：候选人输入与最近推荐品牌完全无关，回退到 noMatchScript 拉群', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const ctxWithUnrelatedBrand: ToolBuildContext = {
        ...mockContext,
        recentBrandPool: ['奥乐齐'],
      };

      const result = await executeTool(ctxWithUnrelatedBrand, {
        ...defaultInput,
        cityNameList: ['上海'],
        brandAliasList: ['真功夫'], // 与"奥乐齐"无任何同音/共享字
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
      expect(result.aliasFuzzyMatch).toBeNull();
      expect(result._replyInstruction).toContain('invite_to_group');
    });

    it('no recentBrandPool：未传品牌池时不触发模糊匹配，照旧走 noMatchScript', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        cityNameList: ['上海'],
        brandAliasList: ['刘姐妹'],
      });

      expect(result.aliasFuzzyMatch).toBeNull();
      expect(result._replyInstruction).toContain('invite_to_group');
    });
  });

  describe('乡镇/街道级地名误当 regionNameList (badcase batch_6a2fabf0536c9654020e6683)', () => {
    it('候选人答"川沙"被塞进 regionNameList 查 0 条：引导先 geocode 而非拉群收口', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        cityNameList: ['上海'],
        regionNameList: ['川沙'],
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_REGION_NEEDS_GEOCODE);
      expect(result._replyInstruction).toContain('geocode');
      // 明确指示「不要直接 invite_to_group 拉群」，而非引导拉群
      expect(result._replyInstruction).toContain('不要直接 invite_to_group');
      expect(result.suspectedRegions).toEqual(['川沙']);
    });

    it('区名简称"浦东"同样引导 geocode 拿规范全称再查', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        cityNameList: ['上海'],
        regionNameList: ['浦东'],
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_REGION_NEEDS_GEOCODE);
    });

    it('规范区级名"浦东新区"命中 0 条：照旧走 noMatchScript 拉群，不再 geocode', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        cityNameList: ['上海'],
        regionNameList: ['浦东新区'],
      });

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_NO_RESULTS);
      expect(result._replyInstruction).toContain('invite_to_group');
    });

    it('乡镇级 region + 已有坐标时不触发 geocode 引导（坐标已足够定位）', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        cityNameList: ['上海'],
        regionNameList: ['川沙'],
        location: { longitude: 121.69, latitude: 31.19 },
      });

      expect(result.errorType).not.toBe(TOOL_ERROR_TYPES.JOB_LIST_REGION_NEEDS_GEOCODE);
    });
  });

  describe('sessionFacts 班次约束逐字段合并 (badcase batch_6a4e430dce406a6aee7a3421)', () => {
    // 候选人要"周六的兼职"（facts 已沉淀 onlyWeekends），模型却传 {onlyEvenings:true}
    // 把周末约束弄丢——持久化约束必须补齐模型漏传的字段，而不是被整体覆盖
    const contextWithWeekendFact = (): ToolBuildContext => ({
      ...mockContext,
      sessionFacts: {
        interview_info: {},
        preferences: {
          schedule_constraint: {
            onlyWeekends: true,
            onlyEvenings: null,
            onlyMornings: null,
            maxDaysPerWeek: null,
          },
        },
      } as ToolBuildContext['sessionFacts'],
    });

    it('模型传了不含 onlyWeekends 的约束时由持久化事实补齐，不整体覆盖', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC' },
            workTime: { remark: '灵活排班，可选时段' },
          }),
        ],
        total: 1,
      });

      const result = await executeTool(contextWithWeekendFact(), {
        ...defaultInput,
        candidateScheduleConstraint: { onlyEvenings: true },
      } as typeof defaultInput);

      expect(result.queryMeta.scheduleFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateConstraint: { onlyWeekends: true, onlyEvenings: true },
        }),
      );
    });

    it('模型传空对象 {} 视同未传，仍走持久化约束兜底', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC' },
            workTime: { remark: '灵活排班，可选时段' },
          }),
        ],
        total: 1,
      });

      const result = await executeTool(contextWithWeekendFact(), {
        ...defaultInput,
        candidateScheduleConstraint: {},
      } as typeof defaultInput);

      expect(result.queryMeta.scheduleFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateConstraint: { onlyWeekends: true },
        }),
      );
    });

    it('模型显式传的同名字段优先于持久化事实（本轮新信息覆盖旧值）', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC' },
            workTime: { remark: '灵活排班，可选时段' },
          }),
        ],
        total: 1,
      });

      const result = await executeTool(contextWithWeekendFact(), {
        ...defaultInput,
        candidateScheduleConstraint: { onlyWeekends: false },
      } as typeof defaultInput);

      expect(result.queryMeta.scheduleFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateConstraint: { onlyWeekends: false },
        }),
      );
    });

    it('无持久化约束时模型入参原样生效', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC' },
            workTime: { remark: '灵活排班，可选时段' },
          }),
        ],
        total: 1,
      });

      const result = await executeTool(mockContext, {
        ...defaultInput,
        candidateScheduleConstraint: { onlyEvenings: true },
      } as typeof defaultInput);

      expect(result.queryMeta.scheduleFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateConstraint: { onlyEvenings: true },
        }),
      );
    });
  });

  describe('用工形式家族放宽提示 laborFormRelaxNotice', () => {
    const contextWithLaborForm = (laborForm: string): ToolBuildContext => ({
      ...mockContext,
      sessionFacts: {
        interview_info: {},
        preferences: { labor_form: laborForm },
      } as ToolBuildContext['sessionFacts'],
    });

    it('严格匹配为空、按兼职家族放宽命中：markdown 注入强制提示且 metadata 带 relaxedToFamily', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC', laborForm: '兼职', partTimeJobType: '小时工' },
          }),
          makeJobData({ basicInfo: { jobId: 2, brandName: '瑞幸', laborForm: '兼职' } }),
          makeJobData({ basicInfo: { jobId: 3, brandName: '奥乐齐', laborForm: '全职' } }),
        ],
        total: 3,
      });

      const result = await executeTool(contextWithLaborForm('寒假工'));

      // 强制提示：禁止把家族岗位包装成候选人原话里的用工形式
      expect(result.markdown).toContain('附近暂无结构化字段严格标注为「寒假工」的岗位');
      expect(result.markdown).toContain('必须按每个岗位真实的用工形式/兼职类型说明');
      expect(result.markdown).toContain('不得把它们统称或包装成「寒假工」');
      expect(result.queryMeta.laborFormFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateLaborForm: '寒假工',
          relaxedToFamily: true,
        }),
      );
      // 家族放宽只扩到 laborForm=兼职：全职岗仍被剔除
      expect(result.resultCount).toBe(2);
      expect(result.markdown).not.toContain('奥乐齐');
    });

    it('严格匹配有结果时不注入放宽提示，relaxedToFamily=false', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({ basicInfo: { jobId: 1, brandName: 'KFC', laborForm: '兼职' } }),
          makeJobData({ basicInfo: { jobId: 2, brandName: '瑞幸', laborForm: '全职' } }),
        ],
        total: 2,
      });

      const result = await executeTool(contextWithLaborForm('兼职'));

      expect(result.markdown).not.toContain('附近暂无结构化字段严格标注为');
      expect(result.queryMeta.laborFormFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateLaborForm: '兼职',
          relaxedToFamily: false,
        }),
      );
      // 严格匹配命中时只保留严格匹配岗位
      expect(result.resultCount).toBe(1);
    });

    it('候选人无用工形式偏好时不过滤也不注入提示', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [makeJobData({ basicInfo: { jobId: 1, brandName: 'KFC', laborForm: '兼职' } })],
        total: 1,
      });

      const result = await executeTool();

      expect(result.markdown).not.toContain('附近暂无结构化字段严格标注为');
      expect(result.queryMeta.laborFormFilter).toEqual({ applied: false });
    });

    it('当前轮明确撤销旧用工形式时不再沿用旧事实硬过滤', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({ basicInfo: { jobId: 1, brandName: '普通兼职品牌', laborForm: '兼职' } }),
        ],
        total: 1,
      });

      const result = await executeTool({
        ...contextWithLaborForm('暑假工'),
        currentLaborFormIntent: { kind: 'clear', clearedValues: ['暑假工'] },
      });

      expect(result.resultCount).toBe(1);
      expect(result.markdown).toContain('普通兼职品牌');
      expect(result.queryMeta.laborFormFilter).toEqual({ applied: false });
    });

    it('要全职时不参与家族放宽：附近只有兼职形态岗位应返回过滤后为空的错误', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: { jobId: 1, brandName: 'KFC', laborForm: '兼职', partTimeJobType: '寒假工' },
          }),
          makeJobData({
            basicInfo: {
              jobId: 2,
              brandName: '瑞幸',
              laborForm: '兼职',
              partTimeJobType: '小时工',
            },
          }),
        ],
        total: 2,
      });

      const result = await executeTool(contextWithLaborForm('全职'));

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY);
      expect(result._replyInstruction).toContain('附近暂时没有全职的岗位');
    });

    it('要暑假工时不参与家族放宽：普通兼职/小时工不得包装成暑假工', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({ basicInfo: { jobId: 1, brandName: 'KFC', laborForm: '兼职' } }),
          makeJobData({
            basicInfo: {
              jobId: 2,
              brandName: '瑞幸',
              laborForm: '兼职',
              partTimeJobType: '小时工',
            },
          }),
        ],
        total: 2,
      });

      const result = await executeTool(contextWithLaborForm('暑假工'));

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY);
      expect(result._replyInstruction).toContain('附近暂时没有暑假工的岗位');
      expect(result._replyInstruction).toContain('把常规岗说成暑假工');
      expect(result._replyInstruction).toContain(
        '不得主动推荐、展示或询问是否考虑普通兼职/小时工/全职',
      );
      expect(result.queryMeta.laborFormFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateLaborForm: '暑假工',
          excludedCount: 2,
        }),
      );
      expect(result.queryMeta.laborFormFilter).not.toHaveProperty('excludedExamples');
    });

    it('要暑假工时不向模型暴露契约异常岗位详情', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: {
              jobId: 99,
              brandName: '脏数据品牌',
              laborForm: '暑假工',
              partTimeJobType: null,
            },
          }),
        ],
        total: 1,
      });

      const result = await executeTool(contextWithLaborForm('暑假工'));

      expect(result.errorType).toBe(TOOL_ERROR_TYPES.JOB_LIST_LABOR_FORM_FILTER_EMPTY);
      expect(result.queryMeta).not.toHaveProperty('laborFormAnomalies');
      expect(JSON.stringify(result)).not.toContain('脏数据品牌');
    });

    it('要暑假工时混合岗位池只返回暑假工，并隐藏被剔除普通岗位详情', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: {
              jobId: 1,
              brandName: '暑假工品牌',
              laborForm: '兼职',
              partTimeJobType: '暑假工',
            },
          }),
          makeJobData({ basicInfo: { jobId: 2, brandName: '普通兼职品牌', laborForm: '兼职' } }),
          makeJobData({
            basicInfo: {
              jobId: 3,
              brandName: '小时工品牌',
              laborForm: '兼职',
              partTimeJobType: '小时工',
            },
          }),
        ],
        total: 3,
      });

      const result = await executeTool(contextWithLaborForm('暑假工'));

      expect(result.resultCount).toBe(1);
      expect(result.markdown).toContain('只能推荐下方暑假工岗位');
      expect(result.markdown).toContain('暑假工品牌');
      expect(result.markdown).not.toContain('普通兼职品牌');
      expect(result.markdown).not.toContain('小时工品牌');
      expect(result.queryMeta.laborFormFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateLaborForm: '暑假工',
          relaxedToFamily: false,
          excludedCount: 2,
        }),
      );
      expect(result.queryMeta.laborFormFilter).not.toHaveProperty('excludedExamples');
    });

    it('当前轮高置信暑假工意向覆盖旧会话兼职意向', async () => {
      mockSpongeService.fetchJobs.mockResolvedValue({
        jobs: [
          makeJobData({
            basicInfo: {
              jobId: 1,
              brandName: '暑假工品牌',
              laborForm: '兼职',
              partTimeJobType: '暑假工',
            },
          }),
          makeJobData({ basicInfo: { jobId: 2, brandName: '普通兼职品牌', laborForm: '兼职' } }),
        ],
        total: 2,
      });

      const result = await executeTool({
        ...contextWithLaborForm('兼职'),
        highConfidenceFacts: {
          preferences: {
            labor_form: {
              value: '暑假工',
              confidence: 'high',
              source: 'rule',
              evidence: '用工形式识别：暑假工',
            },
          },
        } as ToolBuildContext['highConfidenceFacts'],
      });

      expect(result.resultCount).toBe(1);
      expect(result.markdown).toContain('暑假工品牌');
      expect(result.markdown).not.toContain('普通兼职品牌');
      expect(result.queryMeta.laborFormFilter).toEqual(
        expect.objectContaining({
          applied: true,
          candidateLaborForm: '暑假工',
        }),
      );
    });
  });
});
