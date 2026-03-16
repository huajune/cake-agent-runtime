import { Test, TestingModule } from '@nestjs/testing';
import { DulidayJobListToolService } from '@ai/tool/duliday-job-list.tool';
import { SpongeService } from '@ai/sponge/sponge.service';
import { ToolBuildContext } from '@ai/tool/tool.types';

describe('DulidayJobListToolService', () => {
  let service: DulidayJobListToolService;
  let spongeService: { fetchJobs: jest.Mock };

  const mockContext: ToolBuildContext = {
    userId: 'user-1',
    corpId: 'corp-1',
    messages: [],
    channelType: 'private',
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

  beforeEach(async () => {
    spongeService = { fetchJobs: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [DulidayJobListToolService, { provide: SpongeService, useValue: spongeService }],
    }).compile();

    service = module.get(DulidayJobListToolService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
    expect(service.toolName).toBe('duliday_job_list');
  });

  describe('buildTool execute', () => {
    it('should return markdown format by default', async () => {
      spongeService.fetchJobs.mockResolvedValue({
        jobs: [makeJobData()],
        total: 1,
      });

      const builtTool = service.buildTool(mockContext);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const result = (await builtTool.execute(defaultInput as any, {
        toolCallId: 'test',
        messages: [],
        abortSignal: undefined as any,
      })) as any;
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(result.markdown).toBeDefined();
      expect(result.markdown).toContain('KFC');
    });

    it('should return error when no jobs found', async () => {
      spongeService.fetchJobs.mockResolvedValue({ jobs: [], total: 0 });

      const builtTool = service.buildTool(mockContext);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const result = (await builtTool.execute(defaultInput as any, {
        toolCallId: 'test',
        messages: [],
        abortSignal: undefined as any,
      })) as any;
      /* eslint-enable @typescript-eslint/no-explicit-any */

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
      spongeService.fetchJobs.mockResolvedValue({ jobs: [job], total: 1 });

      const onJobsFetched = jest.fn();
      const contextWithCallback = { ...mockContext, onJobsFetched };
      const builtTool = service.buildTool(contextWithCallback);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await builtTool.execute(defaultInput as any, {
        toolCallId: 'test',
        messages: [],
        abortSignal: undefined as any,
      });
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(onJobsFetched).toHaveBeenCalledWith([
        expect.objectContaining({
          jobId: 1,
          brandName: 'KFC',
          salaryDesc: '4000-5000 元/月',
        }),
      ]);
    });

    it('should handle SpongeService error', async () => {
      spongeService.fetchJobs.mockRejectedValue(new Error('API timeout'));

      const builtTool = service.buildTool(mockContext);
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const result = (await builtTool.execute(defaultInput as any, {
        toolCallId: 'test',
        messages: [],
        abortSignal: undefined as any,
      })) as any;
      /* eslint-enable @typescript-eslint/no-explicit-any */

      expect(result.error).toContain('API timeout');
    });
  });
});
