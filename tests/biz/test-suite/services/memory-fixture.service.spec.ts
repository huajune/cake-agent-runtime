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

  const mockBrandStateService = {
    seedFixtureBrandState: jest.fn(),
  };

  const mockLongTermService = {
    setActiveBooking: jest.fn(),
    clearActiveBooking: jest.fn(),
  };

  const scope = {
    corpId: 'corp-1',
    userId: 'user-1',
    sessionId: 'session-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryFixtureService(
      mockMemoryService as any,
      mockSessionService as any,
      mockBrandStateService as any,
      mockLongTermService as any,
    );
  });

  it('should normalize rough badcase context into session facts and job summaries', async () => {
    await service.seed(scope, {
      facts: {
        candidateName: '兮兮',
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
      // 夹具落档已显式署名（记忆审计 S9 关闭 P4 无守卫路径）：saveFacts 只收
      // SessionFacts 单形态，每个值带 confidence/source/evidence，不再靠裸值信封
      // 默默折成未署名档案。evidence 写实话——夹具是测试用例回放的档案。
      expect.objectContaining({
        interview_info: expect.objectContaining({
          name: {
            value: '兮兮',
            confidence: 'medium',
            source: 'archive',
            evidence: 'test-suite 记忆夹具预置',
          },
        }),
        preferences: expect.objectContaining({
          // city 自带 CityFact 的 confidence/evidence，经 toSessionFacts 的 city 专用分支保留。
          city: {
            value: '上海',
            confidence: 'medium',
            evidence: 'explicit_city',
            source: 'archive',
          },
        }),
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

  it('should seed brand_state from fixture brands (preferences.brands 已退役，§19.6)', async () => {
    // 夹具预设的品牌意向存进 facts 对链路已不可见（读边界墓碑），
    // 必须按「末位≈最近」种成 brand_state 才能驱动品牌行为。
    await service.seed(scope, {
      sessionFacts: {
        preferences: { brands: ['肯德基', '来伊份'] },
        reasoning: 'curated fixture',
      },
    });

    expect(mockBrandStateService.seedFixtureBrandState).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      expect.objectContaining({
        currentBrand: { canonicalName: '来伊份', brandId: null },
        excludedBrands: [],
      }),
    );
  });

  it('should not seed brand_state when fixture has no brands', async () => {
    await service.seed(scope, {
      sessionFacts: {
        preferences: { city: '北京' },
        reasoning: 'curated fixture',
      },
    });

    expect(mockBrandStateService.seedFixtureBrandState).not.toHaveBeenCalled();
  });

  it('should complete partial structured facts before saving them', async () => {
    await service.seed(scope, {
      sessionFacts: {
        interview_info: { phone: '18271421690' },
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
          phone: {
            value: '18271421690',
            confidence: 'medium',
            source: 'archive',
            evidence: 'test-suite 记忆夹具预置',
          },
        }),
        preferences: expect.objectContaining({
          city: {
            value: '北京',
            confidence: 'medium',
            evidence: 'explicit_city',
            source: 'archive',
          },
        }),
      }),
    );
    // preferences.brands 字段已随记忆审计 S9 删除。
    expect(mockSessionService.saveFacts.mock.calls[0][3].preferences).not.toHaveProperty('brands');
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

/**
 * 预约工单前置状态注入（2026-08-06）。
 *
 * 单轮 scenarioCase 的 chatHistory 只是消息回放，不重建跨轮状态：badcase au5gy9hy
 * 因会话内没有真实工单，模型自行臆造工单号 WO_2100366180047430400（超出安全整数范围
 * 致工具报错），判据整个落空。改约 / 预约错门店 / 线上面试不得跳过同族均卡在这里。
 */
describe('MemoryFixtureService — activeBookings 前置状态', () => {
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
  const mockBrandStateService = { seedFixtureBrandState: jest.fn() };
  const mockLongTermService = { setActiveBooking: jest.fn(), clearActiveBooking: jest.fn() };
  const scope = { corpId: 'corp-1', userId: 'user-1', sessionId: 'session-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MemoryFixtureService(
      mockMemoryService as any,
      mockSessionService as any,
      mockBrandStateService as any,
      mockLongTermService as any,
    );
  });

  it('注入 activeBookings 时写入长期记忆的预约工单指针', async () => {
    await service.seed(scope, {
      activeBookings: [{ workOrderId: 448367, jobId: 520738 }, { workOrderId: 448402 }],
    });

    expect(mockLongTermService.setActiveBooking).toHaveBeenCalledTimes(2);
    expect(mockLongTermService.setActiveBooking).toHaveBeenNthCalledWith(
      1,
      'corp-1',
      'user-1',
      448367,
      { job_id: 520738 },
    );
    // jobId 缺省落 null，与生产 setActiveBooking 的 metadata 契约一致
    expect(mockLongTermService.setActiveBooking).toHaveBeenNthCalledWith(
      2,
      'corp-1',
      'user-1',
      448402,
      { job_id: null },
    );
  });

  it('未提供 activeBookings 时不触碰长期记忆', async () => {
    await service.seed(scope, { facts: { candidateName: '张三' } });
    expect(mockLongTermService.setActiveBooking).not.toHaveBeenCalled();
  });

  it('workOrderId 非法时抛错，避免静默种出坏 fixture', async () => {
    await expect(
      service.seed(scope, { activeBookings: [{ workOrderId: Number.NaN }] }),
    ).rejects.toThrow('workOrderId');
  });

  it('reset 会清掉预约工单指针，防止跨执行泄漏', async () => {
    await service.reset(scope);
    expect(mockMemoryService.clearSessionMemory).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
    );
    expect(mockLongTermService.clearActiveBooking).toHaveBeenCalledWith('corp-1', 'user-1');
  });
});
