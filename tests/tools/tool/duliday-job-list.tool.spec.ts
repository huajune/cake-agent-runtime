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

  it('should keep markdown output as projected text without raw json field blocks', async () => {
    const job = makeJobData({
      workTime: {
        employmentForm: '长期用工',
        minWorkMonths: 3,
        dayWorkTime: { perDayMinWorkHours: '3.0' },
        dailyShiftSchedule: { arrangementType: '固定排班制' },
      },
    });
    mockSpongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

    const result = await executeTool(mockContext, {
      ...defaultInput,
      responseFormat: ['markdown'],
      includeBasicInfo: true,
      includeWorkTime: true,
    });

    expect(result.markdown).toContain('### 基本信息');
    expect(result.markdown).toContain('### 工作时间');
    expect(result.markdown).not.toContain('字段（完整）');
    expect(result.markdown).not.toContain('```json');
  });
});
