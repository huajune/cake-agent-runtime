import { LongTermService } from '@memory/services/long-term.service';
import {
  FALLBACK_EXTRACTION,
  sessionFactValue,
  toSessionFacts,
} from '@memory/types/session-facts.types';

describe('LongTermService（S7 单一 Profile 上游 + preference 三态）', () => {
  const store = {
    getProfile: jest.fn(),
    upsertProfileFacts: jest.fn().mockResolvedValue(undefined),
    getPreferenceFacts: jest.fn(),
    getSummaryData: jest.fn(),
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
    await service.seedProfileFixture('corp-1', 'user-1', { name: null });
    expect(store.upsertProfileFacts).not.toHaveBeenCalled();

    await service.seedProfileFixture('corp-1', 'user-1', { name: '兮兮' });
    expect(store.upsertProfileFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      { name: expect.objectContaining({ value: '兮兮', confidence: 'medium', source: 'archive' }) },
      undefined,
    );
  });

  it('报名办结是唯一 high Profile 上游，并携带 booking/session/bot 血缘', async () => {
    await service.writeFromBooking(
      'corp-1',
      'user-1',
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

    const facts = store.upsertProfileFacts.mock.calls[0][2];
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

  it('settlement 不再沉淀身份 Profile，只写稳定偏好', async () => {
    const facts = toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        interview_info: { ...FALLBACK_EXTRACTION.interview_info, name: '兮兮' },
        preferences: { ...FALLBACK_EXTRACTION.preferences, position: ['服务员'] },
        reasoning: 'soft preferences',
      },
      { confidence: 'medium', source: 'model', evidence: '软事实提取' },
    );

    await service.writeFromSettlement('corp-1', 'user-1', facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
    });

    expect(store.upsertProfileFacts.mock.calls[0][2]).toEqual({});
    expect(store.upsertProfileFacts.mock.calls[0][4].position).toEqual(
      expect.objectContaining({
        value: ['服务员'],
        confidence: 'medium',
        originSessionId: 'session-A',
        originBotId: 'bot-A',
      }),
    );
  });

  it('偏好缺席表示不动，不发空写', async () => {
    const facts = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '无新软事实',
    });

    await service.writeFromSettlement('corp-1', 'user-1', facts);
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

    await service.writeFromSettlement('corp-1', 'user-1', facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
    });

    const preferenceArg = store.upsertProfileFacts.mock.calls[0][4];
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

    await service.writeFromSettlement('corp-1', 'user-1', facts);
    const saved = store.upsertProfileFacts.mock.calls[0][4];
    expect(saved.city.value).toBe('上海');
    expect(saved.district.value).toEqual(['浦东新区']);
    expect(saved.short_term).toBeUndefined();
    expect(saved.time_windows).toBeUndefined();
  });

  it('品牌快照仍是 settlement preference，不写 Profile', async () => {
    const facts = toSessionFacts(FALLBACK_EXTRACTION, {
      confidence: 'medium',
      source: 'model',
      evidence: '无新软事实',
    });
    await service.writeFromSettlement('corp-1', 'user-1', facts, {
      sessionId: 'session-A',
      botImId: 'bot-A',
      brandState: {
        currentBrand: { canonicalName: '肯德基', brandId: 101 },
        excludedBrands: [],
        updatedAtMs: 1,
      },
    });
    expect(store.upsertProfileFacts.mock.calls[0][2]).toEqual({});
    expect(store.upsertProfileFacts.mock.calls[0][4].brands.value).toEqual(['肯德基']);
  });

  it('按 bot 召回摘要时只返回同账号 recent，并 fail-closed 丢弃混合 archive', async () => {
    store.getSummaryData.mockResolvedValue({
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

    const result = await service.getSummaryData('corp-1', 'user-1', 'bot-A');
    expect(result?.recent.map((entry) => entry.summary)).toEqual(['A']);
    expect(result?.archive).toBeNull();
  });
});
