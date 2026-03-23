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
});
