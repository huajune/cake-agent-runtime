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
});
