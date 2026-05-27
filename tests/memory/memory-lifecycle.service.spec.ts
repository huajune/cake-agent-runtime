import { MemoryLifecycleService } from '@memory/services/memory-lifecycle.service';
import { unwrapHighConfidenceValue } from '@memory/facts/high-confidence-facts';
import {
  FALLBACK_EXTRACTION,
  type HighConfidenceFacts,
  type HighConfidenceValue,
} from '@memory/types/session-facts.types';

function highConfidence<T>(
  value: T,
  evidence: string,
  source: HighConfidenceValue<T>['source'] = 'rule',
): HighConfidenceValue<T> {
  return { value, confidence: source === 'system' ? 'low' : 'high', source, evidence };
}

function emptyHighConfidenceFacts(): HighConfidenceFacts {
  return {
    interview_info: {
      name: null,
      phone: null,
      gender: null,
      gender_source: null,
      age: null,
      applied_store: null,
      applied_position: null,
      interview_time: null,
      is_student: null,
      education: null,
      has_health_certificate: null,
    },
    preferences: {
      brands: null,
      salary: null,
      position: null,
      schedule: null,
      city: null,
      district: null,
      location: null,
      labor_form: null,
      delayed_intent: null,
      short_term: null,
      open_position: null,
      time_windows: null,
      schedule_constraint: null,
      available_after: null,
    },
    reasoning: 'test',
  };
}

describe('MemoryLifecycleService', () => {
  const mockShortTerm = {
    getMessages: jest.fn(),
    lastLoadError: null as string | null,
  };

  const mockSessionService = {
    getSessionState: jest.fn(),
    saveLastCandidatePool: jest.fn().mockResolvedValue(undefined),
    projectAssistantTurn: jest.fn().mockResolvedValue(undefined),
    extractAndSave: jest.fn().mockResolvedValue(undefined),
  };

  const mockSettlement = {
    detectAndSettle: jest.fn().mockResolvedValue(false),
  };

  const mockProcedural = {
    get: jest.fn(),
  };

  const mockLongTerm = {
    getProfile: jest.fn(),
  };

  const mockSponge = {
    fetchBrandList: jest.fn().mockResolvedValue([
      { name: '来伊份', aliases: ['来一份', '来1份'] },
      { name: '肯德基', aliases: ['KFC'] },
    ]),
  };

  const mockEnrichment = {
    enrich: jest.fn(),
  };

  const mockMessageProcessing = {
    updatePostProcessingStatus: jest.fn().mockResolvedValue(true),
  };

  let service: MemoryLifecycleService;

  beforeEach(() => {
    jest.clearAllMocks();
    mockShortTerm.lastLoadError = null;
    mockSettlement.detectAndSettle.mockResolvedValue(false);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: null,
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
    });
    mockEnrichment.enrich.mockImplementation(async (snapshot) => snapshot);
    mockMessageProcessing.updatePostProcessingStatus.mockResolvedValue(true);

    service = new MemoryLifecycleService(
      mockShortTerm as never,
      mockProcedural as never,
      mockLongTerm as never,
      mockSettlement as never,
      mockSessionService as never,
      mockSponge as never,
      mockEnrichment as never,
      mockMessageProcessing as never,
    );
  });

  it('should load full runtime memory on turn start', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: 'hello' }]);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: { interview_info: { name: '张三' }, preferences: {}, reasoning: '' },
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
    });
    mockProcedural.get.mockResolvedValue({
      currentStage: 'job_consultation',
      fromStage: 'trust_building',
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue({
      name: {
        value: '张三',
        confidence: 'high',
        source: 'booking',
        evidence: '测试写入',
        updatedAt: '2026-05-22T10:00:00.000Z',
      },
      phone: {
        value: '138',
        confidence: 'high',
        source: 'booking',
        evidence: '测试写入',
        updatedAt: '2026-05-22T10:00:00.000Z',
      },
    });

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1');

    expect(mockShortTerm.getMessages).toHaveBeenCalledWith('sess-1');
    expect(mockSessionService.getSessionState).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1');
    expect(mockProcedural.get).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1');
    expect(mockLongTerm.getProfile).toHaveBeenCalledWith('corp-1', 'user-1');
    expect(ctx.sessionMemory).not.toBeNull();
    expect(ctx.highConfidenceFacts).toBeNull();
    expect(ctx.shortTerm.messageWindow).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('should forward short-term cutoff on turn start', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: 'hello' }]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    await service.onTurnStart('corp-1', 'user-1', 'sess-1', 'hello', {
      shortTermEndTimeInclusive: 1710900000000,
    });

    expect(mockShortTerm.getMessages).toHaveBeenCalledWith('sess-1', {
      endTimeInclusive: 1710900000000,
    });
  });

  it('should propagate short-term load warnings into runtime memory context', async () => {
    mockShortTerm.getMessages.mockResolvedValue([]);
    mockShortTerm.lastLoadError = 'Connection timeout';
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1');

    expect(ctx._warnings).toEqual(['shortTerm: Connection timeout']);
  });

  it('should expose high-confidence facts separately on turn start', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: '来一份' }]);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: null,
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
    });
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', '来一份');

    expect(mockSponge.fetchBrandList).toHaveBeenCalled();
    expect(ctx.sessionMemory).toBeNull();
    expect(ctx.highConfidenceFacts?.preferences.brands).toEqual(
      expect.objectContaining({ value: ['来伊份'], source: 'rule' }),
    );
  });

  it('should keep persisted session memory unchanged and return high-confidence facts separately', async () => {
    mockShortTerm.getMessages.mockResolvedValue([
      { role: 'user', content: '上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空' },
    ]);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          brands: ['来伊份'],
        },
      },
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
    });
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart(
      'corp-1',
      'user-1',
      'sess-1',
      '上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空',
    );

    expect(ctx.sessionMemory?.facts?.preferences.brands).toEqual(['来伊份']);
    expect(ctx.sessionMemory?.facts?.preferences.city).toBeNull();
    expect(ctx.highConfidenceFacts?.preferences.city).toEqual({
      value: '上海',
      confidence: 'high',
      source: 'rule',
      evidence: 'municipality_compact',
    });
    expect(unwrapHighConfidenceValue(ctx.highConfidenceFacts?.preferences.district)).toEqual([
      '杨浦',
    ]);
    expect(ctx.highConfidenceFacts?.interview_info.gender).toEqual(
      expect.objectContaining({ value: '男' }),
    );
    expect(ctx.highConfidenceFacts?.interview_info.age).toEqual(
      expect.objectContaining({
        value: '25',
        confidence: 'high',
        source: 'rule',
        evidence: '年龄识别：25',
      }),
    );
  });

  it('should normalize compact structured age into standard high-confidence facts', async () => {
    mockShortTerm.getMessages.mockResolvedValue([
      { role: 'user', content: '姓名：张琰\n电话：19986247174\n年龄24\n明天吧\n有' },
    ]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'interview_scheduling',
      fromStage: 'trust_building',
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart(
      'corp-1',
      'user-1',
      'sess-1',
      '姓名：张琰\n电话：19986247174\n年龄24\n明天吧\n有',
    );

    expect(ctx.highConfidenceFacts?.interview_info).toEqual(
      expect.objectContaining({
        name: expect.objectContaining({ value: '张琰' }),
        phone: expect.objectContaining({ value: '19986247174' }),
        age: expect.objectContaining({ value: '24' }),
      }),
    );
  });

  it('should fallback to current user message when short-term window is empty', async () => {
    mockShortTerm.getMessages.mockResolvedValue([]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', '救急消息');

    expect(ctx.shortTerm.messageWindow).toEqual([{ role: 'user', content: '救急消息' }]);
  });

  it('should not apply fallback when short-term window is non-empty', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: '历史消息' }]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', '救急消息');

    expect(ctx.shortTerm.messageWindow).toEqual([{ role: 'user', content: '历史消息' }]);
  });

  it('should invoke enrichment when identity is provided', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: 'hi' }]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);
    mockEnrichment.enrich.mockImplementation(async (snapshot) => ({
      ...snapshot,
      highConfidenceFacts: {
        ...emptyHighConfidenceFacts(),
        interview_info: {
          ...emptyHighConfidenceFacts().interview_info,
          gender: highConfidence('男', '客户详情接口补充性别：男', 'system'),
        },
        reasoning: 'enriched',
      },
    }));

    const identity = { token: 't', imBotId: 'b', imContactId: 'c' };
    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', undefined, {
      enrichmentIdentity: identity,
    });

    expect(mockEnrichment.enrich).toHaveBeenCalledWith(expect.any(Object), identity);
    expect(ctx.highConfidenceFacts?.interview_info.gender).toEqual(
      expect.objectContaining({ value: '男', source: 'system' }),
    );
  });

  it('should skip enrichment when identity is not provided', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: 'hi' }]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    await service.onTurnStart('corp-1', 'user-1', 'sess-1');

    expect(mockEnrichment.enrich).not.toHaveBeenCalled();
  });

  it('should not fallback to short-term history when current turn messages are absent', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: '来一份' }]);
    mockProcedural.get.mockResolvedValue({
      currentStage: 'trust_building',
      fromStage: null,
      advancedAt: null,
      reason: null,
    });
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1');

    expect(mockSponge.fetchBrandList).not.toHaveBeenCalled();
    expect(ctx.highConfidenceFacts).toBeNull();
  });

  it('should run detectAndSettle, project jobs, and trigger extraction on turn end', async () => {
    mockSessionService.getSessionState.mockResolvedValue({
      facts: null,
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
    });

    await service.onTurnEnd(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        normalizedMessages: [
          { role: 'assistant', content: '杨浦这边有长白这家店。' },
          {
            role: 'user',
            content: [
              { type: 'text', text: '[图片 messageId=img-1]' },
              { type: 'image', image: new URL('https://example.com/test.png') },
              { type: 'text', text: '我想报名长白' },
            ],
          },
        ],
        candidatePool: [
          {
            jobId: 519709,
            brandName: '奥乐齐',
            jobName: '分拣打包',
            storeName: '长白',
            cityName: '上海',
            regionName: '杨浦',
            laborForm: '全职',
            salaryDesc: '6200-9800 元/月',
            jobCategoryName: '分拣员',
          },
        ],
      },
      '可以，我先帮你确认下长白这边的面试要求。',
    );

    expect(mockSessionService.getSessionState).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1');
    expect(mockSettlement.detectAndSettle).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'sess-1',
      null, // facts is null
    );
    expect(mockSessionService.saveLastCandidatePool).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'sess-1',
      [
        {
          jobId: 519709,
          brandName: '奥乐齐',
          jobName: '分拣打包',
          storeName: '长白',
          cityName: '上海',
          regionName: '杨浦',
          laborForm: '全职',
          salaryDesc: '6200-9800 元/月',
          jobCategoryName: '分拣员',
        },
      ],
    );
    expect(mockSessionService.projectAssistantTurn).toHaveBeenCalledWith({
      corpId: 'corp-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      userText: '[图片 messageId=img-1] 我想报名长白',
      assistantText: '可以，我先帮你确认下长白这边的面试要求。',
    });
    expect(mockSessionService.extractAndSave).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1', [
      { role: 'assistant', content: '杨浦这边有长白这家店。' },
      { role: 'user', content: '[图片 messageId=img-1] 我想报名长白' },
    ]);
  });

  it('should persist running and final post-processing status when messageId is present', async () => {
    await service.onTurnEnd(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        normalizedMessages: [{ role: 'user', content: '我想找长白附近的兼职' }],
        candidatePool: [
          {
            jobId: 519709,
            brandName: '奥乐齐',
            jobName: '分拣打包',
            storeName: '长白',
            cityName: '上海',
            regionName: '杨浦',
            laborForm: '全职',
            salaryDesc: '6200-9800 元/月',
            jobCategoryName: '分拣员',
          },
        ],
      },
      '可以，我先帮你确认下长白这边的面试要求。',
    );

    expect(mockMessageProcessing.updatePostProcessingStatus).toHaveBeenNthCalledWith(
      1,
      'msg-1',
      expect.objectContaining({
        status: 'running',
        steps: [],
      }),
    );
    expect(mockMessageProcessing.updatePostProcessingStatus).toHaveBeenLastCalledWith(
      'msg-1',
      expect.objectContaining({
        status: 'completed',
        counts: expect.objectContaining({
          total: expect.any(Number),
          failed: 0,
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({ name: 'load_previous_state', status: 'success' }),
          expect.objectContaining({ name: 'settlement', status: 'success' }),
          expect.objectContaining({ name: 'save_candidate_pool', status: 'success' }),
          expect.objectContaining({ name: 'project_assistant_turn', status: 'success' }),
          expect.objectContaining({ name: 'extract_facts', status: 'success' }),
        ]),
      }),
    );
  });

  it('should aggregate failed turn-end steps into completed_with_errors status', async () => {
    mockSessionService.extractAndSave.mockRejectedValueOnce(new Error('extract failed'));

    await service.onTurnEnd(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        messageId: 'msg-2',
        normalizedMessages: [{ role: 'user', content: '继续看看' }],
      },
      '好的',
    );

    expect(mockMessageProcessing.updatePostProcessingStatus).toHaveBeenLastCalledWith(
      'msg-2',
      expect.objectContaining({
        status: 'completed_with_errors',
        counts: expect.objectContaining({
          failed: 1,
        }),
        steps: expect.arrayContaining([
          expect.objectContaining({
            name: 'extract_facts',
            status: 'failure',
            success: false,
            error: 'extract failed',
          }),
        ]),
      }),
    );
  });

  it('should skip lifecycle work when there is no user message', async () => {
    await service.onTurnEnd({
      corpId: 'corp-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      normalizedMessages: [{ role: 'assistant', content: '你好' }],
    });

    expect(mockSessionService.getSessionState).not.toHaveBeenCalled();
    expect(mockSessionService.projectAssistantTurn).not.toHaveBeenCalled();
    expect(mockSessionService.extractAndSave).not.toHaveBeenCalled();
  });
});
