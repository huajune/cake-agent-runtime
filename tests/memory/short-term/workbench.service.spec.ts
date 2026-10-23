import { SessionWorkbenchService } from '@memory/short-term/workbench.service';

describe('SessionWorkbenchService stage pointer', () => {
  const mockRedisStore = {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfig = { sessionTtl: 86400, sessionFactsTtl: 129600 };

  let service: SessionWorkbenchService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionWorkbenchService(
      {} as never,
      mockRedisStore as never,
      mockConfig as never,
    );
  });

  describe('get', () => {
    it('should return null state when no data in Redis', async () => {
      mockRedisStore.get.mockResolvedValue(null);

      const state = await service.getStage('corp1', 'user1', 'session1');

      expect(state).toEqual({ currentStage: null });
    });

    it('should return stored stage state', async () => {
      mockRedisStore.get.mockResolvedValue({
        content: {
          currentStage: 'needs_collection',
          fromStage: 'trust_building',
          advancedAt: '2026-03-20T10:00:00Z',
          reason: '信任建立完成',
        },
      });

      const state = await service.getStage('corp1', 'user1', 'session1');

      // 旧记录里的 fromStage/advancedAt/reason 不再读出（记忆审计 S10 删只写字段）：
      // 它们只写不读，存量随会话 TTL 自然过期。
      expect(state).toEqual({ currentStage: 'needs_collection' });
    });
  });

  describe('set', () => {
    it('should write stage to Redis with the same TTL as session facts', async () => {
      await service.setStage('corp1', 'user1', 'session1', {
        currentStage: 'job_recommendation',
      });

      expect(mockRedisStore.set).toHaveBeenCalledWith(
        'stage:corp1:user1:session1',
        expect.objectContaining({ currentStage: 'job_recommendation' }),
        129600,
        false,
      );
    });
  });
});

describe('SessionWorkbenchService attested focus job', () => {
  const mockFacts = {
    getSessionState: jest.fn(),
    patchSessionState: jest.fn().mockResolvedValue(undefined),
  };
  const mockRedisStore = { get: jest.fn(), set: jest.fn() };
  const mockConfig = { sessionTtl: 86400, sessionFactsTtl: 129600 };

  const summary = (jobId: number, salaryDesc: string | null = null) => ({
    jobId,
    brandName: '奥乐齐',
    jobName: `奥乐齐-${jobId}-补货`,
    storeName: `门店${jobId}`,
    cityName: '上海',
    regionName: '闵行区',
    laborForm: '兼职',
    salaryDesc,
    jobCategoryName: '补货',
  });

  let service: SessionWorkbenchService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionWorkbenchService(
      mockFacts as never,
      mockRedisStore as never,
      mockConfig as never,
    );
  });

  it('候选池已过期时直接把 precheck 投影写成焦点岗位', async () => {
    mockFacts.getSessionState.mockResolvedValue({ presentedJobs: null, lastCandidatePool: null });

    await service.saveAttestedFocusJob('corp1', 'user1', 'session1', summary(523254));

    expect(mockFacts.patchSessionState).toHaveBeenCalledWith('corp1', 'user1', 'session1', {
      currentFocusJob: summary(523254),
    });
  });

  it('候选池里有同岗位的完整摘要时优先落那一份', async () => {
    const richer = summary(523254, '22元/小时');
    mockFacts.getSessionState.mockResolvedValue({
      presentedJobs: [summary(520437, '20元/小时')],
      lastCandidatePool: [richer],
    });

    await service.saveAttestedFocusJob('corp1', 'user1', 'session1', summary(523254));

    expect(mockFacts.patchSessionState).toHaveBeenCalledWith('corp1', 'user1', 'session1', {
      currentFocusJob: richer,
    });
  });
});

describe('SessionWorkbenchService 岗位记忆持久化保留 studentTier', () => {
  const mockFacts = {
    getSessionState: jest.fn().mockResolvedValue({ presentedJobs: null }),
    patchSessionState: jest.fn().mockResolvedValue(undefined),
  };
  const job = {
    jobId: 529083,
    brandName: '肯德基',
    jobName: '服务员',
    storeName: '上海虹桥店',
    cityName: '上海',
    regionName: '闵行区',
    laborForm: '兼职',
    salaryDesc: null,
    jobCategoryName: null,
    studentRequirement: '不接受学生（仅限社会人士）',
    studentTier: 'social_only' as const,
  };
  let service: SessionWorkbenchService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SessionWorkbenchService(
      mockFacts as never,
      { get: jest.fn(), set: jest.fn() } as never,
      { sessionTtl: 86400 } as never,
    );
  });

  // zod object 默认剥未知键：schema 漏登记时档位会在落 Redis 前被静默丢掉。
  it('候选池 / 已展示岗位 / 焦点岗位三处写入都保留结构化档位', async () => {
    await service.saveLastCandidatePool('corp1', 'user1', 'session1', [job]);
    await service.savePresentedJobs('corp1', 'user1', 'session1', [job]);
    await service.saveCurrentFocusJob('corp1', 'user1', 'session1', job);

    const patches = mockFacts.patchSessionState.mock.calls.map((call) => call[3]);
    expect(patches[0].lastCandidatePool[0].studentTier).toBe('social_only');
    expect(patches[1].presentedJobs[0].studentTier).toBe('social_only');
    expect(patches[2].currentFocusJob.studentTier).toBe('social_only');
  });

  it('缺档位的历史记录照常写入，不补默认值', async () => {
    const { studentTier: _omitted, ...legacy } = job;
    await service.saveCurrentFocusJob('corp1', 'user1', 'session1', legacy);

    expect(mockFacts.patchSessionState.mock.calls[0][3].currentFocusJob).not.toHaveProperty(
      'studentTier',
    );
  });
});
