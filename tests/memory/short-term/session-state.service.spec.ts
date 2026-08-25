import { SessionFactsService } from '@memory/short-term/facts.service';
import { SessionWorkbenchService } from '@memory/short-term/workbench.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import {
  FALLBACK_EXTRACTION,
  SessionFactsSchema,
  sessionFactValue,
  toSessionFacts,
} from '@memory/short-term/short-term.types';

const preferences = (overrides: Record<string, unknown> = {}) => ({
  brand_ids: null,
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
  ...overrides,
});

describe('SessionStateService（S1-S6）', () => {
  let hash: Record<string, unknown>;
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    getHash: jest.fn(),
    patchHash: jest.fn(),
    backfillHash: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(true),
  };
  const llm = { generateStructured: jest.fn() };
  const sponge = {
    fetchBrandList: jest.fn().mockResolvedValue([{ id: 1, name: '肯德基', aliases: ['KFC'] }]),
  };
  const systemConfig = { getExtractModelOverride: jest.fn().mockResolvedValue(undefined) };
  const config = {
    sessionTtl: 86400,
    sessionFactsTtl: 129600,
    sessionExtractionIncrementalMessages: 8,
    consolidationGapSeconds: 86400,
  };
  let service: SessionStateService;

  beforeEach(() => {
    jest.clearAllMocks();
    hash = {};
    redis.getHash.mockImplementation(async () =>
      Object.keys(hash).length > 0 ? { ...hash } : null,
    );
    redis.patchHash.mockImplementation(async (_key, patch: Record<string, unknown>) => {
      hash = { ...hash, ...patch };
    });
    sponge.fetchBrandList.mockResolvedValue([{ id: 1, name: '肯德基', aliases: ['KFC'] }]);
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences(),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '好的' },
        reasoning: '本轮无新信息',
      },
      modelId: 'test/extract',
    });
    const facts = new SessionFactsService(
      redis as never,
      config as never,
      llm as never,
      sponge as never,
      systemConfig as never,
    );
    service = new SessionStateService(
      facts,
      new SessionWorkbenchService(facts, redis as never, config as never),
    );
  });

  const softFacts = (overrides: Record<string, unknown> = {}) =>
    toSessionFacts(
      {
        ...FALLBACK_EXTRACTION,
        preferences: { ...FALLBACK_EXTRACTION.preferences, ...overrides },
        reasoning: 'spec',
      },
      { confidence: 'medium', source: 'model', evidence: 'spec soft fact' },
    );

  it('读边界把历史 low/unknown 统一归一为 medium', () => {
    const parsed = SessionFactsSchema.parse({
      ...softFacts(),
      preferences: {
        ...softFacts().preferences,
        schedule: {
          value: '晚班',
          confidence: 'low',
          source: 'model',
          evidence: 'legacy',
        },
      },
    });
    expect(parsed.preferences.schedule?.confidence).toBe('medium');
  });

  it('saveFacts 精确替换身份组，仅对 preferences 执行三态合并', async () => {
    const first = softFacts({
      city: { value: '上海', confidence: 'medium', evidence: 'explicit_city' },
    });
    first.interview_info.name = sessionFactValue('兮兮', {
      confidence: 'high',
      source: 'candidate_quote',
      evidence: '表单办结',
    });
    await service.saveFacts('corp-1', 'user-1', 'session-1', first);

    const second = softFacts({ schedule: '晚班' });
    await service.saveFacts('corp-1', 'user-1', 'session-1', second);
    const saved = await service.getFacts('corp-1', 'user-1', 'session-1');

    expect(saved?.interview_info.name).toBeNull();
    expect(saved?.preferences.city?.value).toBe('上海');
    expect(saved?.preferences.schedule?.value).toBe('晚班');
    expect(redis.patchHash).toHaveBeenLastCalledWith(
      'factsv2:corp-1:user-1:session-1',
      expect.any(Object),
      config.sessionFactsTtl,
    );
  });

  it('通用 facts 写入保留 reducer 独占的 brand 原值', async () => {
    const brand = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [],
      updatedAtMs: 1000,
    };
    hash = { facts: { ...softFacts(), brand } };

    await service.saveFacts('corp-1', 'user-1', 'session-1', softFacts({ schedule: '晚班' }));

    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.brand).toEqual(brand);
  });

  it('旧顶层 brand_state 读时懒迁移到 facts.brand，嵌套值立即生效', async () => {
    const brand = {
      currentBrand: { canonicalName: '肯德基', brandId: 1 },
      excludedBrands: [],
      updatedAtMs: 1000,
    };
    const { brand: _brand, ...legacyFacts } = softFacts();
    hash = { facts: legacyFacts, brand_state: brand };

    const state = await service.getSessionState('corp-1', 'user-1', 'session-1');

    expect(state.facts?.brand).toEqual(brand);
    expect(redis.patchHash).toHaveBeenCalledWith(
      'factsv2:corp-1:user-1:session-1',
      expect.objectContaining({ facts: expect.objectContaining({ brand }) }),
      config.sessionFactsTtl,
    );
  });

  it('收资办结入口只接受 high，并保留既有软偏好', async () => {
    await service.saveFacts('corp-1', 'user-1', 'session-1', softFacts({ position: ['服务员'] }));

    await expect(
      service.saveCompletedCollectionFacts('corp-1', 'user-1', 'session-1', {
        name: sessionFactValue('兮兮', {
          confidence: 'medium',
          source: 'model',
          evidence: 'not form',
        }),
      }),
    ).rejects.toThrow('must be high');

    await service.saveCompletedCollectionFacts('corp-1', 'user-1', 'session-1', {
      name: sessionFactValue('兮兮', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '收资表单办结',
      }),
    });
    const saved = await service.getFacts('corp-1', 'user-1', 'session-1');
    expect(saved?.interview_info.name?.value).toBe('兮兮');
    expect(saved?.preferences.position?.value).toEqual(['服务员']);
  });

  it('轮末 LLM 纯偏好提取不会覆盖 booking high 身份字段', async () => {
    const bookingIdentity = {
      name: sessionFactValue('兮兮', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '报名成功姓名',
      }),
      phone: sessionFactValue('13800138000', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '报名成功手机',
      }),
      gender: sessionFactValue('女', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '报名成功性别',
      }),
      gender_source: sessionFactValue('candidate' as const, {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '报名成功性别来源',
      }),
      age: sessionFactValue('25', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '报名成功年龄',
      }),
    };
    await service.saveCompletedCollectionFacts('corp-1', 'user-1', 'session-1', bookingIdentity);
    llm.generateStructured.mockResolvedValue({
      output: {
        interview_info: { name: '伪造姓名' },
        preferences: preferences({ schedule: '晚班' }),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '我只能晚班' },
        reasoning: '提取班次',
      },
      modelId: 'test/extract',
    });

    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '我只能晚班' },
    ]);
    const saved = await service.getFacts('corp-1', 'user-1', 'session-1');
    expect(saved?.interview_info).toEqual(
      expect.objectContaining(
        Object.fromEntries(
          Object.entries(bookingIdentity).map(([key, value]) => [
            key,
            expect.objectContaining(value),
          ]),
        ),
      ),
    );
    expect(saved?.preferences.schedule).toEqual(
      expect.objectContaining({ value: '晚班', confidence: 'medium' }),
    );
  });

  it('相同 preference 值不刷新旧信封的时间与证据', async () => {
    const originalPosition = sessionFactValue(['服务员'], {
      confidence: 'medium',
      source: 'model',
      evidence: '候选人最初明确说服务员',
      extractedAt: '2026-08-01T00:00:00.000Z',
    });
    const initial = softFacts();
    initial.preferences.position = originalPosition;
    await service.saveFacts('corp-1', 'user-1', 'session-1', initial);
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ position: ['服务员'] }),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '还是服务员' },
        reasoning: '重复确认岗位',
      },
      modelId: 'test/extract',
    });

    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '还是服务员' },
    ]);

    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.position).toEqual(
      originalPosition,
    );
  });

  it('LLM 显式空数组写成墓碑，null 则表示缺席', async () => {
    await service.saveFacts(
      'corp-1',
      'user-1',
      'session-1',
      softFacts({ location: ['陆家嘴'], district: ['浦东新区'] }),
    );
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ location: [], district: null }),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '地点不限' },
        reasoning: '清空地点',
      },
      modelId: 'test/extract',
    });

    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '地点不限' },
    ]);
    const saved = await service.getFacts('corp-1', 'user-1', 'session-1');
    expect(saved?.preferences.location).toEqual(expect.objectContaining({ value: null }));
    expect(saved?.preferences.district?.value).toEqual(['浦东新区']);
  });

  it('城市模型写入与工具确权都共用单一裁决器', async () => {
    await service.saveFacts(
      'corp-1',
      'user-1',
      'session-1',
      softFacts({ city: { value: '上海', confidence: 'medium', evidence: 'explicit_city' } }),
    );
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ city: '北京' }),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '随便' },
        reasoning: '冲突城市',
      },
      modelId: 'test/extract',
    });
    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '随便看看' },
    ]);
    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.city?.value).toBe(
      '上海',
    );

    hash = {};
    await expect(
      service.saveToolAttestedCity('corp-1', 'user-1', 'session-2', {
        city: '上海',
        source: 'geocode_unique',
        evidence: '地图解析',
      }),
    ).resolves.toBe('written');
    await expect(
      service.saveToolAttestedCity('corp-1', 'user-1', 'session-2', {
        city: '北京',
        source: 'geocode_unique',
        evidence: '地图解析',
      }),
    ).resolves.toBe('skipped_city_conflict');
  });

  it('事务字段已从 sessionFacts schema 退出', () => {
    const parsed = SessionFactsSchema.parse({
      ...softFacts(),
      interview_info: {
        ...softFacts().interview_info,
        applied_store: sessionFactValue('测试门店', {
          confidence: 'medium',
          source: 'model',
          evidence: 'legacy',
        }),
        interview_time: sessionFactValue('2026-08-21 10:00', {
          confidence: 'medium',
          source: 'model',
          evidence: 'legacy',
        }),
      },
    });
    expect(parsed.interview_info).not.toHaveProperty('applied_store');
    expect(parsed.interview_info).not.toHaveProperty('interview_time');
  });
});
