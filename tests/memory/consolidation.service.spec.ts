import { ConsolidationService } from '@memory/long-term/consolidation.service';
import { FALLBACK_EXTRACTION, toSessionFacts } from '@memory/short-term/short-term.types';

describe('ConsolidationService（M5 定时闲置沉淀）', () => {
  const BOT_USER_ID = 'wecom-user-1';
  const GAP_SECONDS = 3 * 24 * 60 * 60;
  const now = Date.parse('2026-08-25T12:00:00.000Z');
  const latestAt = now - GAP_SECONDS * 1000;

  const longTerm = {
    getSessionSummaries: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    writeFromConsolidation: jest.fn().mockResolvedValue(undefined),
  };
  const chatSession = {
    getChatHistory: jest.fn(),
    getChatHistoryInRange: jest.fn(),
  };
  const llm = {
    generate: jest.fn().mockResolvedValue({ text: '候选人咨询了服务员岗位。' }),
  };
  const systemConfig = {
    getExtractModelOverride: jest.fn().mockResolvedValue(undefined),
  };

  let service: ConsolidationService;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    longTerm.getSessionSummaries.mockResolvedValue({
      recent: [],
      archive: null,
      lastSettledMessageAt: null,
      lastSettledBySession: {},
    });
    longTerm.appendSummary.mockResolvedValue(undefined);
    longTerm.writeFromConsolidation.mockResolvedValue(undefined);
    chatSession.getChatHistory.mockResolvedValue([
      { role: 'assistant', content: '好的', timestamp: latestAt },
    ]);
    chatSession.getChatHistoryInRange.mockResolvedValue([
      { role: 'user', content: '我想找服务员', timestamp: latestAt - 60_000 },
      { role: 'assistant', content: '好的', timestamp: latestAt },
    ]);
    llm.generate.mockResolvedValue({ text: '候选人咨询了服务员岗位。' });

    service = new ConsolidationService(
      { consolidationGapSeconds: GAP_SECONDS } as never,
      longTerm as never,
      chatSession as never,
      llm as never,
      systemConfig as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('闲置满 3 天时直接沉淀当前咨询段，不再等待回访', async () => {
    const result = await service.consolidateIdleSession(
      'corp-1',
      'user-1',
      'session-1',
      BOT_USER_ID,
      null,
    );

    expect(result).toEqual({ status: 'consolidated', latestMessageAt: latestAt });
    expect(longTerm.appendSummary).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      BOT_USER_ID,
      expect.objectContaining({
        sessionId: 'session-1',
        endTime: new Date(latestAt).toISOString(),
      }),
      expect.objectContaining({
        lastSettledMessageAt: new Date(latestAt).toISOString(),
        sessionId: 'session-1',
      }),
    );
  });

  it('到点复核发现新消息时返回精确剩余 delay，不写长期记忆', async () => {
    const freshAt = now - 60_000;
    chatSession.getChatHistory.mockResolvedValue([
      { role: 'user', content: '刚发的新消息', timestamp: freshAt },
    ]);

    const result = await service.consolidateIdleSession(
      'corp-1',
      'user-1',
      'session-1',
      BOT_USER_ID,
      null,
    );

    expect(result).toEqual({
      status: 'not_idle',
      latestMessageAt: freshAt,
      retryDelayMs: GAP_SECONDS * 1000 - 60_000,
    });
    expect(longTerm.appendSummary).not.toHaveBeenCalled();
  });

  it('lastSettledBySession 已覆盖最新消息时幂等跳过', async () => {
    longTerm.getSessionSummaries.mockResolvedValue({
      recent: [],
      archive: null,
      lastSettledMessageAt: null,
      lastSettledBySession: { 'session-1': new Date(latestAt).toISOString() },
    });

    const result = await service.consolidateIdleSession(
      'corp-1',
      'user-1',
      'session-1',
      BOT_USER_ID,
      null,
    );

    expect(result).toEqual({ status: 'already_consolidated', latestMessageAt: latestAt });
    expect(chatSession.getChatHistoryInRange).not.toHaveBeenCalled();
    expect(longTerm.appendSummary).not.toHaveBeenCalled();
  });

  it('首次接管存量 chat 只取最后一个连续咨询段', async () => {
    const oldAt = latestAt - 5 * 24 * 60 * 60 * 1000;
    chatSession.getChatHistoryInRange.mockResolvedValue([
      { role: 'user', content: '很早以前的一段', timestamp: oldAt },
      { role: 'assistant', content: '旧回复', timestamp: oldAt + 60_000 },
      { role: 'user', content: '当前咨询段', timestamp: latestAt - 60_000 },
      { role: 'assistant', content: '当前回复', timestamp: latestAt },
    ]);

    await service.consolidateIdleSession('corp-1', 'user-1', 'session-1', BOT_USER_ID, null);

    expect(llm.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('当前咨询段'),
      }),
    );
    expect(llm.generate.mock.calls[0][0].prompt).not.toContain('很早以前的一段');
  });

  it('读取到事实时将 facts.brand 原样交给长期沉淀路径', async () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, position: ['服务员'] },
      },
      { confidence: 'medium', source: 'model', evidence: '测试' },
    );
    facts.brand = {
      currentBrand: { canonicalName: '肯德基', brandId: 101 },
      excludedBrands: [],
      updatedAtMs: now,
    };

    await service.consolidateIdleSession(
      'corp-1',
      'user-1',
      'session-1',
      BOT_USER_ID,
      facts,
      'bot-1',
      facts.brand,
    );

    expect(longTerm.writeFromConsolidation).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      BOT_USER_ID,
      facts,
      { sessionId: 'session-1', botImId: 'bot-1', brandState: facts.brand },
    );
  });

  it('LLM 或持久化失败向上抛出，交给 Bull 重试', async () => {
    llm.generate.mockRejectedValueOnce(new Error('llm down'));

    await expect(
      service.consolidateIdleSession('corp-1', 'user-1', 'session-1', BOT_USER_ID, null),
    ).rejects.toThrow('llm down');
    expect(longTerm.appendSummary).not.toHaveBeenCalled();
  });

  it('缺少 DB 最新消息时失败而非静默跳过', async () => {
    chatSession.getChatHistory.mockResolvedValue([]);

    await expect(
      service.consolidateIdleSession('corp-1', 'user-1', 'session-1', BOT_USER_ID, null),
    ).rejects.toThrow('memory_consolidation_latest_message_missing:session-1');
  });
});
