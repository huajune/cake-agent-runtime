import { MemoryFixtureService } from '@biz/test-suite/services/memory-fixture.service';

describe('MemoryFixtureService', () => {
  let service: MemoryFixtureService;

  const mockMemoryService = {
    clearSessionMemory: jest.fn(),
    saveInvitedGroup: jest.fn(),
    saveProfile: jest.fn(),
    setStage: jest.fn(),
    getStage: jest.fn(),
  };

  const mockSessionService = {
    saveFacts: jest.fn(),
    saveLastCandidatePool: jest.fn(),
    saveLastJobListQuery: jest.fn(),
    savePresentedJobs: jest.fn(),
    saveCurrentFocusJob: jest.fn(),
    getSessionState: jest.fn(),
  };

  const scope = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryFixtureService(mockMemoryService as any, mockSessionService as any);
  });

  it('should normalize rough badcase context into session facts and job summaries', async () => {
    await service.seed(scope, {
      facts: {
        candidateName: '张三',
      },
      sessionFacts: {
        source: 'badcase-context-backfill',
        city: '上海',
        anchorUserMessage: '想找静安附近的兼职',
      },
      presentedJobs: [{ jobId: 524017, source: 'processing.toolArgs.jobIdList' }],
      currentStage: 'job_matching',
    });

    expect(mockSessionService.saveFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({
        interview_info: expect.objectContaining({ name: '张三' }),
        preferences: expect.objectContaining({
          city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
        }),
        reasoning: 'badcase-context-backfill: 想找静安附近的兼职',
      }),
    );
    expect(mockSessionService.savePresentedJobs).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      [
        expect.objectContaining({
          jobId: 524017,
          brandName: null,
          jobName: null,
          storeName: null,
        }),
      ],
    );
    expect(mockMemoryService.setStage).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({ currentStage: 'job_matching' }),
    );
  });

  it('should complete partial structured facts before saving them', async () => {
    await service.seed(scope, {
      sessionFacts: {
        interview_info: { phone: '13800000000' },
        preferences: { city: '北京' },
        reasoning: 'curated fixture',
      },
    });

    expect(mockSessionService.saveFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({
        interview_info: expect.objectContaining({
          name: null,
          phone: '13800000000',
        }),
        preferences: expect.objectContaining({
          city: { value: '北京', confidence: 'high', evidence: 'explicit_city' },
          brands: null,
        }),
        reasoning: 'curated fixture',
      }),
    );
  });

  it('should derive the previous job-list query fingerprint from query params', async () => {
    await service.seed(scope, {
      lastJobListQuery: {
        queryParams: {
          cityNameList: ['上海'],
          regionNameList: ['黄浦区'],
          brandAliasList: [],
          brandIdList: [],
          projectNameList: [],
          projectIdList: [],
          storeNameList: [],
          jobCategoryList: [],
          jobIdList: [],
          salaryPeriodNameList: [],
        },
        turnId: 'previous-turn',
        updatedAtMs: 123,
      },
    });

    expect(mockSessionService.saveLastJobListQuery).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      {
        signature:
          '{"city":["上海"],"region":["黄浦区"],"brandAlias":[],"brandId":[],"brandMode":null,"excludeBrand":[],"project":[],"projectId":[],"store":[],"searchJobName":null,"category":[],"jobId":[],"settlement":[],"location":null,"schedule":null,"laborForm":null}',
        turnId: 'previous-turn',
        updatedAtMs: 123,
      },
    );
  });

  it('keeps legacy signature fixtures compatible', async () => {
    await service.seed(scope, {
      lastJobListQuery: {
        signature: 'legacy-signature',
        turnId: 'previous-turn',
      },
    });

    expect(mockSessionService.saveLastJobListQuery).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      {
        signature: 'legacy-signature',
        turnId: 'previous-turn',
        updatedAtMs: undefined,
      },
    );
  });
});
