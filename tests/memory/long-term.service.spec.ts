import { LongTermService } from '@memory/long-term/long-term.service';
import {
  FALLBACK_EXTRACTION,
  sessionFactValue,
  toSessionFacts,
} from '@memory/short-term/short-term.types';

describe('LongTermService（S7 单一 Profile 上游 + preference 三态）', () => {
  const BOT_USER_ID = 'wecom-user-1';
  const store = {
    getProfile: jest.fn(),
    upsertProfileFacts: jest.fn().mockResolvedValue(undefined),
    getPreferenceFacts: jest.fn(),
    getSessionSummaries: jest.fn(),
    appendSummary: jest.fn().mockResolvedValue(undefined),
    markLastSettledMessageAt: jest.fn().mockResolvedValue(undefined),
    upsertMessageMetadata: jest.fn().mockResolvedValue(undefined),
    getActiveBookings: jest.fn(),
    setActiveBooking: jest.fn().mockResolvedValue(undefined),
  };
  let service: LongTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    store.upsertProfileFacts.mockResolvedValue(undefined);
    service = new LongTermService(store as never);
  });

  it('测试夹具 Profile 只写 medium/archive，空夹具不写', async () => {
    await service.seedProfileFixture('corp-1', 'user-1', BOT_USER_ID, { name: null });
    expect(store.upsertProfileFacts).not.toHaveBeenCalled();

    await service.seedProfileFixture('corp-1', 'user-1', BOT_USER_ID, { name: '兮兮' });
    expect(store.upsertProfileFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      BOT_USER_ID,
      { name: expect.objectContaining({ value: '兮兮', confidence: 'medium', source: 'archive' }) },
      undefined,
    );
  });

  it('报名办结是最高置信 Profile 上游，并携带 booking/session/bot 血缘', async () => {
    await service.writeFromBooking(
      'corp-1',
      'user-1',
      BOT_USER_ID,
      {
        name: '兮兮',
        phone: '18271421690',
        age: 25,
        gender: '女',
        jobId: 100,
        workOrderId: 9001,
      },
      { sessionId: 'session-A', botImId: 'bot-A' },
    );

    const facts = store.upsertProfileFacts.mock.calls[0][3];
    expect(facts.name).toEqual(
      expect.objectContaining({
        value: '兮兮',
        confidence: 'high',
        source: 'system',
        originSessionId: 'session-A',
        originBotId: 'bot-A',
      }),
    );
    expect(facts.phone.value).toBe('18271421690');
    expect(facts.age.value).toBe('25');
    expect(facts.name.evidence).toContain('jobId=100');
    expect(facts.name.evidence).toContain('workOrderId=9001');
  });

  it('consolidation 以 medium 透传身份 Profile，并同时写稳定偏好', async () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '兮兮' },
        preferences: { ...FALLBACK_EXTRACTION.preferences, position: ['服务员'] },
        reasoning: 'soft preferences',
      },
      { confidence: 'medium', source: 'model', evidence: '软事实提取' },
    );

    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
    });

    expect(store.upsertProfileFacts.mock.calls[0][3].name).toEqual(
      expect.objectContaining({
        value: '兮兮',
        confidence: 'medium',
        source: 'model',
        originSessionId: 'session-A',
        originBotId: 'bot-A',
      }),
    );
    expect(store.upsertProfileFacts.mock.calls[0][5].position).toEqual(
      expect.objectContaining({
        value: ['服务员'],
        confidence: 'medium',
        originSessionId: 'session-A',
        originBotId: 'bot-A',
      }),
    );
  });

  it('consolidation 只有身份字段时仍写入 Profile', async () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, education: '本科' },
      },
      { confidence: 'medium', source: 'candidate_quote', evidence: '候选人自述本科' },
    );

    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
    });

    expect(store.upsertProfileFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      BOT_USER_ID,
      {
        education: expect.objectContaining({
          value: '本科',
          confidence: 'medium',
          source: 'candidate_quote',
        }),
      },
      undefined,
      {},
    );
  });

  it('偏好缺席表示不动，不发空写', async () => {
    const facts = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '无新软事实',
    });

    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts);
    expect(store.upsertProfileFacts).not.toHaveBeenCalled();
  });

  it('显式清空以 value=null 墓碑写入，能穿过非空对象闸门', async () => {
    const facts = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '无新软事实',
    });
    facts.preferences.location = sessionFactValue(null, {
      confidence: 'medium',
      source: 'candidate_quote',
      evidence: '候选人明确表示地点不限',
    });

    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
    });

    const preferenceArg = store.upsertProfileFacts.mock.calls[0][5];
    expect(preferenceArg.location).toEqual(
      expect.objectContaining({
        value: null,
        confidence: 'medium',
        originSessionId: 'session-A',
        originBotId: 'bot-A',
      }),
    );
    expect(Object.keys(preferenceArg)).toEqual(['location']);
  });

  it('有值偏好按字段替换写入，临时 episode 字段不沉淀', async () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        preferences: {
          ...FALLBACK_EXTRACTION.preferences,
          city: { value: '上海', confidence: 'medium', evidence: 'explicit_city' },
          district: ['浦东新区'],
          short_term: true,
          time_windows: ['17点后'],
        },
        reasoning: 'soft preferences',
      },
      { confidence: 'medium', source: 'model', evidence: '软事实提取' },
    );

    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts);
    const saved = store.upsertProfileFacts.mock.calls[0][5];
    expect(saved.city.value).toBe('上海');
    expect(saved.district.value).toEqual(['浦东新区']);
    expect(saved.short_term).toBeUndefined();
    expect(saved.time_windows).toBeUndefined();
  });

  it('品牌快照仍是 consolidation preference，不写 Profile', async () => {
    const facts = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '无新软事实',
    });
    await service.writeFromConsolidation('corp-1', 'user-1', BOT_USER_ID, facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
      brandState: {
        currentBrand: { canonicalName: '肯德基', brandId: 101 },
        excludedBrands: [],
        updatedAtMs: 1,
      },
    });
    expect(store.upsertProfileFacts.mock.calls[0][3]).toEqual({});
    expect(store.upsertProfileFacts.mock.calls[0][5].brands.value).toEqual(['肯德基']);
  });

  it('按稳定 bot 关系键读取摘要，不再做字段级 originBotId 过滤', async () => {
    store.getSessionSummaries.mockResolvedValue({
      recent: [
        {
          summary: 'A',
          sessionId: 's-A',
          originBotId: 'bot-A',
          startTime: '2026-08-20',
          endTime: '2026-08-20',
        },
        {
          summary: 'B',
          sessionId: 's-B',
          originBotId: 'bot-B',
          startTime: '2026-08-20',
          endTime: '2026-08-20',
        },
      ],
      archive: 'mixed',
      lastSettledMessageAt: null,
    });

    const result = await service.getSessionSummaries('corp-1', 'user-1', BOT_USER_ID);
    expect(store.getSessionSummaries).toHaveBeenCalledWith('corp-1', 'user-1', BOT_USER_ID);
    expect(result?.recent.map((entry) => entry.summary)).toEqual(['A', 'B']);
    expect(result?.archive).toBe('mixed');
  });
});
