import { MemoryLifecycleService } from '@memory/services/memory-lifecycle.service';
import { produceRuleFactClaims } from '@resolution/evidence/producers/rule-track';
import { getRuleFact } from '@resolution/evidence/merge';
import { FALLBACK_EXTRACTION } from '@memory/session/session-facts.types';
import { testRuleFact, testRuleFacts } from '../helpers/rule-fact-claims.fixture';

describe('MemoryLifecycleService', () => {
  const mockShortTerm = {
    getMessages: jest.fn(),
    lastLoadError: null as string | null,
  };

  const mockSessionService = {
    getSessionState: jest.fn(),
    saveLastCandidatePool: jest.fn().mockResolvedValue(undefined),
    saveLastJobListQuery: jest.fn().mockResolvedValue(undefined),
    projectAssistantTurn: jest.fn().mockResolvedValue(undefined),
    extractAndSave: jest.fn().mockResolvedValue({ llmDegraded: false, brandIntents: [] }),
    saveToolAttestedCity: jest.fn().mockResolvedValue('written'),
  };

  const mockBrandState = {
    applyTurnResolutions: jest.fn().mockResolvedValue({ changed: false, initialized: false }),
  };

  const mockSettlement = {
    detectAndSettle: jest.fn().mockResolvedValue(false),
  };

  const mockProcedural = {
    get: jest.fn(),
  };

  const mockLongTerm = {
    getProfile: jest.fn(),
    getPreferences: jest.fn().mockResolvedValue(null),
    getSessionSummaries: jest.fn().mockResolvedValue(null),
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

  const prepRuleFacts = async (text: string) =>
    produceRuleFactClaims([text], await mockSponge.fetchBrandList());

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

    mockSessionService.extractAndSave.mockResolvedValue({ llmDegraded: false, brandIntents: [] });
    mockBrandState.applyTurnResolutions.mockResolvedValue({ changed: false, initialized: false });

    service = new MemoryLifecycleService(
      mockShortTerm as never,
      mockProcedural as never,
      mockLongTerm as never,
      mockSettlement as never,
      mockSessionService as never,
      mockSponge as never,
      mockEnrichment as never,
      mockMessageProcessing as never,
      mockBrandState as never,
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
        source: 'system',
        evidence: '测试写入',
        updatedAt: '2026-05-22T10:00:00.000Z',
      },
      phone: {
        value: '138',
        confidence: 'high',
        source: 'system',
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
    expect(ctx.ruleFacts).toBeNull();
    expect(ctx.shortTerm.messageWindow).toEqual([{ role: 'user', content: 'hello' }]);
  });

  it('should retain a session state that only contains the last job-list query', async () => {
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: '再看看' }]);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: null,
      lastCandidatePool: null,
      presentedJobs: null,
      currentFocusJob: null,
      lastJobListQuery: {
        signature: '{"city":["上海"]}',
        turnId: 'turn-1',
        updatedAtMs: 1,
      },
    });
    mockProcedural.get.mockResolvedValue(null);
    mockLongTerm.getProfile.mockResolvedValue(null);

    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1');

    expect(ctx.sessionMemory?.lastJobListQuery).toEqual(
      expect.objectContaining({ turnId: 'turn-1' }),
    );
  });

  describe('cross-conversation origin detection', () => {
    const profileFromOtherChat = {
      name: {
        value: '张三',
        confidence: 'high' as const,
        source: 'archive' as const,
        evidence: '会话沉淀提取',
        updatedAt: '2026-06-08T10:00:00.000Z',
        originSessionId: 'chat-A',
        originBotId: 'bot-wxid-A',
      },
    };

    beforeEach(() => {
      mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: 'hi' }]);
      mockProcedural.get.mockResolvedValue({
        currentStage: 'job_consultation',
        fromStage: null,
        advancedAt: null,
        reason: null,
      });
    });

    it('flags fromOtherConversation when a fresh chat recalls facts settled by another session', async () => {
      mockLongTerm.getProfile.mockResolvedValue(profileFromOtherChat);

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-NEW');

      expect(ctx.longTerm.origin?.fromOtherConversation).toBe(true);
    });

    it('does NOT flag when the current session already has its own session memory', async () => {
      mockSessionService.getSessionState.mockResolvedValue({
        facts: { interview_info: { name: '张三' }, preferences: {}, reasoning: '' },
        lastCandidatePool: null,
        presentedJobs: null,
        currentFocusJob: null,
      });
      mockLongTerm.getProfile.mockResolvedValue(profileFromOtherChat);

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-NEW');

      expect(ctx.longTerm.origin).toBeUndefined();
    });

    it('does NOT flag when recalled facts originated from the current session', async () => {
      mockLongTerm.getProfile.mockResolvedValue({
        name: { ...profileFromOtherChat.name, originSessionId: 'sess-NEW' },
      });

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-NEW');

      expect(ctx.longTerm.origin).toBeUndefined();
    });

    it('falls back to consolidation boundaries when facts lack origin lineage (legacy data)', async () => {
      mockLongTerm.getProfile.mockResolvedValue({
        name: {
          value: '张三',
          confidence: 'high',
          source: 'system',
          evidence: '历史写入（无血缘）',
          updatedAt: '2026-06-05T10:00:00.000Z',
        },
      });
      mockLongTerm.getSessionSummaries.mockResolvedValue({
        recent: [],
        archive: null,
        lastSettledMessageAt: '2026-06-08T10:00:00.000Z',
        lastSettledBySession: { 'chat-A': '2026-06-08T10:00:00.000Z' },
      });

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-NEW');

      expect(ctx.longTerm.origin?.fromOtherConversation).toBe(true);
    });

    it('does NOT flag when there is no long-term memory at all', async () => {
      mockLongTerm.getProfile.mockResolvedValue(null);

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-NEW');

      expect(ctx.longTerm.origin).toBeUndefined();
    });

    it('有 bot 上下文时只召回同账号血缘事实，存量无血缘也 fail-closed', async () => {
      mockLongTerm.getProfile.mockResolvedValue({
        name: {
          value: '兮兮',
          confidence: 'high',
          source: 'system',
          evidence: 'booking A',
          updatedAt: '2026-08-20T10:00:00.000Z',
          originSessionId: 'session-A',
          originBotId: 'bot-A',
        },
        phone: {
          value: '18271421690',
          confidence: 'high',
          source: 'system',
          evidence: 'booking B',
          updatedAt: '2026-08-20T10:00:00.000Z',
          originSessionId: 'session-B',
          originBotId: 'bot-B',
        },
        age: {
          value: '25',
          confidence: 'high',
          source: 'system',
          evidence: 'legacy without bot lineage',
          updatedAt: '2026-08-20T10:00:00.000Z',
        },
      });

      const ctx = await service.onTurnStart('corp-1', 'user-1', 'session-B', '继续', {
        enrichmentIdentity: { imBotId: 'bot-B' },
      });

      expect(ctx.longTerm.semantic.profile?.name).toBeNull();
      expect(ctx.longTerm.semantic.profile?.age).toBeNull();
      expect(ctx.longTerm.semantic.profile?.phone).toEqual(
        expect.objectContaining({ value: '18271421690', originBotId: 'bot-B' }),
      );
      expect(mockLongTerm.getSessionSummaries).toHaveBeenCalledWith('corp-1', 'user-1', 'bot-B');
    });
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
    // 品牌写入收口（§9.2）后，前置识别不再把品牌写进 preferences.brands
    // （品牌真相只在 brand_state），但品牌线索仍进 reasoning 供排障参考；
    // 用带其它规则信号的消息验证前置识别本身照常工作。
    mockShortTerm.getMessages.mockResolvedValue([{ role: 'user', content: '来一份，我25岁' }]);
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

    const text = '来一份，我25岁';
    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', text, {
      ruleFacts: await prepRuleFacts(text),
    });

    expect(mockSponge.fetchBrandList).toHaveBeenCalled();
    expect(ctx.sessionMemory).toBeNull();
    expect(ctx.ruleFacts?.claims.some((claim) => claim.field.includes('brands'))).toBe(false);
    expect(ctx.ruleFacts?.reasoning).toContain('来伊份');
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.age')).toEqual(
      expect.objectContaining({ value: '25' }),
    );
  });

  it('should keep persisted session memory unchanged and return high-confidence facts separately', async () => {
    mockShortTerm.getMessages.mockResolvedValue([
      { role: 'user', content: '上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空' },
    ]);
    mockSessionService.getSessionState.mockResolvedValue({
      facts: FALLBACK_EXTRACTION,
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

    const text = '上海杨浦，我是男生，25岁，有健康证，想找兼职服务员，周末有空';
    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', text, {
      ruleFacts: await prepRuleFacts(text),
    });

    // preferences.brands 字段已删（记忆审计 S9）：品牌唯一真相是 brand_state。
    expect(ctx.sessionMemory?.facts?.preferences).not.toHaveProperty('brands');
    expect(ctx.sessionMemory?.facts?.preferences.city).toBeNull();
    expect(getRuleFact(ctx.ruleFacts, 'preferences.city')).toEqual(
      expect.objectContaining({
        value: '上海',
        confidence: 'high',
        producer: 'rule',
        evidence: expect.objectContaining({ code: 'municipality_compact' }),
      }),
    );
    expect(getRuleFact(ctx.ruleFacts, 'preferences.district')?.value).toEqual(['杨浦']);
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.gender')).toEqual(
      expect.objectContaining({ value: '男' }),
    );
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.age')).toEqual(
      expect.objectContaining({
        value: '25',
        confidence: 'high',
        producer: 'rule',
        evidence: expect.objectContaining({ label: '年龄识别：25' }),
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

    const text = '姓名：张琰\n电话：19986247174\n年龄24\n明天吧\n有';
    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', text, {
      ruleFacts: await prepRuleFacts(text),
    });

    expect(getRuleFact(ctx.ruleFacts, 'interview_info.name')?.value).toBe('张琰');
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.phone')?.value).toBe('19986247174');
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.age')?.value).toBe('24');
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
      ruleFacts: testRuleFacts(
        testRuleFact('interview_info.gender', '男', '客户详情接口补充性别：男', {
          confidence: 'low',
          producer: 'system',
        }),
      ),
    }));

    const identity = { token: 't', imBotId: 'b', imContactId: 'c' };
    const ctx = await service.onTurnStart('corp-1', 'user-1', 'sess-1', undefined, {
      enrichmentIdentity: identity,
    });

    expect(mockEnrichment.enrich).toHaveBeenCalledWith(expect.any(Object), identity);
    expect(getRuleFact(ctx.ruleFacts, 'interview_info.gender')).toEqual(
      expect.objectContaining({ value: '男', producer: 'system' }),
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
    expect(ctx.ruleFacts).toBeNull();
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
        botImId: 'bot-wxid-1',
        ruleFacts: null,
        laborFormIntent: { kind: 'ignore' },
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
        jobListQuerySignature: '{"city":["上海"]}',
      },
      '可以，我先帮你确认下长白这边的面试要求。',
    );

    expect(mockSessionService.getSessionState).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1');
    expect(mockSettlement.detectAndSettle).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'sess-1',
      null, // facts is null
      'bot-wxid-1', // botImId forwarded as fact lineage
      null, // brand_state（长期意向品牌快照源，§19.6）；本用例会话无品牌状态
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
    expect(mockSessionService.saveLastJobListQuery).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'sess-1',
      expect.objectContaining({
        signature: '{"city":["上海"]}',
        turnId: null,
        updatedAtMs: expect.any(Number),
      }),
    );
    expect(mockSessionService.projectAssistantTurn).toHaveBeenCalledWith({
      corpId: 'corp-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      userText: '[图片 messageId=img-1] 我想报名长白',
      assistantText: '可以，我先帮你确认下长白这边的面试要求。',
    });
    expect(mockSessionService.extractAndSave).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'sess-1',
      [
        { role: 'assistant', content: '杨浦这边有长白这家店。' },
        { role: 'user', content: '[图片 messageId=img-1] 我想报名长白' },
      ],
      null,
      { kind: 'ignore' },
      undefined,
    );
  });

  it('should persist running and final post-processing status when messageId is present', async () => {
    await service.onTurnEnd(
      {
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        ruleFacts: null,
        laborFormIntent: { kind: 'ignore' },
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
          expect.objectContaining({ name: 'consolidation', status: 'success' }),
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
        ruleFacts: null,
        laborFormIntent: { kind: 'ignore' },
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
      ruleFacts: null,
      laborFormIntent: { kind: 'ignore' },
      normalizedMessages: [{ role: 'assistant', content: '你好' }],
    });

    expect(mockSessionService.getSessionState).not.toHaveBeenCalled();
    expect(mockSessionService.projectAssistantTurn).not.toHaveBeenCalled();
    expect(mockSessionService.extractAndSave).not.toHaveBeenCalled();
    expect(mockBrandState.applyTurnResolutions).not.toHaveBeenCalled();
  });

  describe('save_attested_city 步骤（候选人资料证据化 A1）', () => {
    const attestation = {
      city: '沈阳市',
      district: '浑南区',
      evidence: 'geocode 唯一解析：辽宁省沈阳市浑南区奥体中心(公交站)',
      source: 'geocode_unique' as const,
    };

    it('携带 cityAttestation → 在 extract_facts 之前写入工具确权城市', async () => {
      await service.onTurnEnd(
        {
          corpId: 'corp-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          ruleFacts: null,
          laborFormIntent: { kind: 'ignore' },
          normalizedMessages: [{ role: 'user', content: '好的' }],
          cityAttestation: attestation,
        },
        '帮你查下沈阳的群',
      );

      expect(mockSessionService.saveToolAttestedCity).toHaveBeenCalledWith(
        'corp-1',
        'user-1',
        'sess-1',
        attestation,
      );
      const attestOrder = mockSessionService.saveToolAttestedCity.mock.invocationCallOrder[0];
      const extractOrder = mockSessionService.extractAndSave.mock.invocationCallOrder[0];
      expect(attestOrder).toBeLessThan(extractOrder);
    });

    it('无 cityAttestation → 不触发写入', async () => {
      await service.onTurnEnd(
        {
          corpId: 'corp-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          ruleFacts: null,
          laborFormIntent: { kind: 'ignore' },
          normalizedMessages: [{ role: 'user', content: '好的' }],
        },
        '收到',
      );

      expect(mockSessionService.saveToolAttestedCity).not.toHaveBeenCalled();
    });
  });

  describe('apply_brand_state 步骤（§6.3.1 时序）', () => {
    it('排在 extract_facts 之后，汇总规则轨 + 图片轨 + LLM 轨结果进 reducer', async () => {
      const llmIntent = {
        canonicalName: '麦当劳',
        brandId: null,
        matchedText: '麦当劳',
        sourceText: '不要麦当劳',
        source: 'user_text' as const,
        matchType: 'canonical_exact' as const,
        intentPolarity: 'negative' as const,
        confidence: 0.95,
        ambiguous: false,
      };
      mockSessionService.extractAndSave.mockResolvedValue({
        llmDegraded: false,
        brandIntents: [llmIntent],
      });
      const imageResolution = {
        canonicalName: '肯德基',
        brandId: null,
        matchedText: '肯德基',
        sourceText: '肯德基门店招聘',
        source: 'image_description' as const,
        matchType: 'canonical_exact' as const,
        intentPolarity: 'positive' as const,
        confidence: 0.95,
        ambiguous: false,
      };

      await service.onTurnEnd(
        {
          corpId: 'corp-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          messageId: 'msg-3',
          contactName: '小王 肯德基',
          ruleFacts: null,
          laborFormIntent: { kind: 'ignore' },
          normalizedMessages: [{ role: 'user', content: '我想去KFC' }],
          imageBrandResolutions: [imageResolution],
        },
        '好的',
      );

      expect(mockBrandState.applyTurnResolutions).toHaveBeenCalledTimes(1);
      const call = mockBrandState.applyTurnResolutions.mock.calls[0][0];
      expect(call.contactName).toBe('小王 肯德基');
      // 图片轨透传 + LLM 轨极性结果 + 规则轨对本轮 user 文本的解析（KFC → 肯德基）
      expect(call.resolutions).toEqual(
        expect.arrayContaining([
          imageResolution,
          llmIntent,
          expect.objectContaining({ canonicalName: '肯德基', source: 'user_text' }),
        ]),
      );
      // 步骤顺序：apply_brand_state 在 extract_facts 之后
      const finalStatus = mockMessageProcessing.updatePostProcessingStatus.mock.calls.at(-1)![1];
      const stepNames = finalStatus.steps.map((step: { name: string }) => step.name);
      expect(stepNames.indexOf('apply_brand_state')).toBeGreaterThan(
        stepNames.indexOf('extract_facts'),
      );
    });

    it('extract_facts 抛错/降级时 reducer 仍以规则轨结果照常运行并落状态', async () => {
      mockSessionService.extractAndSave.mockRejectedValueOnce(new Error('extract failed'));

      await service.onTurnEnd(
        {
          corpId: 'corp-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          messageId: 'msg-4',
          ruleFacts: null,
          laborFormIntent: { kind: 'ignore' },
          normalizedMessages: [{ role: 'user', content: '不要肯德基' }],
        },
        '好的',
      );

      expect(mockBrandState.applyTurnResolutions).toHaveBeenCalledTimes(1);
      const call = mockBrandState.applyTurnResolutions.mock.calls[0][0];
      expect(call.resolutions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ canonicalName: '肯德基', intentPolarity: 'negative' }),
        ]),
      );
      const finalStatus = mockMessageProcessing.updatePostProcessingStatus.mock.calls.at(-1)![1];
      expect(finalStatus.steps).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'extract_facts', status: 'failure' }),
          expect.objectContaining({ name: 'apply_brand_state', status: 'success' }),
        ]),
      );
    });
  });
});
