import type { z } from 'zod';
import { testTurnHint, testTurnHints } from '../../helpers/turn-hints.fixture';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { produceTurnHints } from '@resolution/turn-hints/producers/rule-track';
import { SessionFactsService } from '@memory/short-term/facts.service';
import { LongTermService } from '@memory/long-term/long-term.service';
import { SessionWorkbenchService } from '@memory/short-term/workbench.service';
import { SessionStateService } from '@memory/short-term/session-state.service';
import { extractScheduleConstraintStructured } from '@resolution/turn-hints/producers/rule-track-preferences';
import {
  FALLBACK_EXTRACTION,
  SessionFactsSchema,
  sessionFactValue,
  toSessionFacts,
  type ScheduleConstraintFact,
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

  it('班次增量保存：省略延续、数组替换、明确空值撤销', async () => {
    await service.saveFacts(
      'corp-1',
      'user-1',
      'session-1',
      softFacts({
        schedule: '18点后',
        time_windows: ['18点后'],
        schedule_constraint: {
          onlyWeekends: true,
          onlyEvenings: true,
          includeAnyTags: ['evening'],
          availableWindow: { start: '18:00' },
        },
      }),
    );
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({
          schedule_constraint: { includeAnyTags: [], availableWindow: null },
        }),
        schedule_constraint_citation: { quote: '时间不限了' },
        reasoning: '撤销日内限制',
      },
    });
    await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '时间不限了' }],
      testTurnHints(testTurnHint('preferences.schedule', '18点后', '旧钟点')),
    );
    const value = (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences
      .schedule_constraint;
    expect(value).toMatchObject({
      value: { onlyWeekends: true, includeAnyTags: [], availableWindow: null },
      evidence: '时间不限了',
      source: 'candidate_quote',
    });
    expect(value?.value).not.toHaveProperty('onlyEvenings');
    const saved = (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences;
    expect(saved.schedule).toMatchObject({ value: null });
    expect(saved.time_windows).toMatchObject({ value: null });
  });
  it('正常班次抽取与无变化都不会被旧规则轨覆盖', async () => {
    const hints = testTurnHints(
      testTurnHint('preferences.schedule_constraint', { onlyEvenings: true }, '晚班'),
    );
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ schedule_constraint: { excludeTags: ['evening'] } }),
        schedule_constraint_citation: { quote: '晚班不行' },
        reasoning: '排除晚班',
      },
    });
    await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '晚班不行' }],
      hints,
    );
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.schedule_constraint
        ?.value,
    ).toEqual({ excludeTags: ['evening'] });
    llm.generateStructured.mockResolvedValue({
      output: { preferences: preferences(), reasoning: '只问事实' },
    });
    await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '晚班几点下班？' }],
      hints,
    );
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.schedule_constraint
        ?.value,
    ).toEqual({ excludeTags: ['evening'] });
  });
  it('班次引用只认本轮候选人，助手和旧轮引文不入记忆', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ schedule_constraint: { includeAnyTags: ['evening'] } }),
        schedule_constraint_citation: { quote: '我只做晚班' },
        reasoning: '错误旧引文',
      },
    });
    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '我只做晚班' },
      { role: 'assistant', content: '收到' },
      { role: 'user', content: '薪资多少？' },
    ]);
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.schedule_constraint,
    ).toBeNull();
  });
  it('本轮连续消息中较早的班次引文也能保存', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ schedule_constraint: { excludeTags: ['night'] } }),
        schedule_constraint_citation: { quote: '夜班不做' },
        reasoning: '本轮首条消息排除夜班',
      },
    });
    await service.extractAndSave('corp-1', 'user-1', 'session-1', [
      { role: 'user', content: '以前白天都可以' },
      { role: 'assistant', content: '现在有什么时间要求？' },
      { role: 'user', content: '夜班不做' },
      { role: 'user', content: '帮我找上海的' },
    ]);
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.schedule_constraint,
    ).toMatchObject({
      value: { excludeTags: ['night'] },
      source: 'candidate_quote',
      evidence: '夜班不做',
    });
    const prompt = JSON.stringify(llm.generateStructured.mock.calls.at(-1)?.[0]);
    const current = prompt.slice(prompt.indexOf('[当前消息]'));
    expect(current).toContain('夜班不做');
    expect(current).toContain('帮我找上海的');
    expect(current).not.toContain('以前白天都可以');
  });
  it('模型降级时跨日规则提示仍能保存，且不丢失同轮其他偏好', async () => {
    llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));
    const message = '晚上10点到次日6点有空';
    const outcome = await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: message }],
      testTurnHints(
        testTurnHint(
          'preferences.schedule_constraint',
          extractScheduleConstraintStructured(message),
          message,
        ),
        testTurnHint('preferences.position', ['服务员'], '想做服务员'),
      ),
    );
    expect(outcome.llmDegraded).toBe(true);
    const saved = (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences;
    expect(saved.schedule_constraint?.value.availableWindow).toEqual({
      start: '22:00',
      end: '06:00',
      endDayOffset: 1,
    });
    expect(saved.position?.value).toEqual(['服务员']);
  });

  describe('班次条件：字段隔离、文本入口、询问与工具兜底', () => {
    const scope = ['corp-1', 'user-1', 'session-1'] as const;
    const savedPreferences = async () => (await service.getFacts(...scope))?.preferences;
    /** 模拟 AI SDK Output.object：按抽取 schema 校验模型原始输出，校验失败即整次结构化输出失败。 */
    const respondValidated = (output: Record<string, unknown>) =>
      llm.generateStructured.mockImplementation(async ({ schema }: { schema: z.ZodTypeAny }) => ({
        output: schema.parse(output),
        modelId: 'test/extract',
      }));

    it.each<[string, Record<string, unknown>]>([
      ['跨日漏写 endDayOffset', { availableWindow: { start: '22:00', end: '06:00' } }],
      ['起止相同', { availableWindow: { start: '18:00', end: '18:00' } }],
      ['多余字段', { includeAnyTags: ['evening'], onlyEvenings: true }],
      ['钟点格式不合契约', { availableWindow: { start: '6:00' } }],
    ])(
      '抽取的班次条件不合契约（%s）时只丢弃班次，同轮其他偏好照常保存',
      async (_label, scheduleConstraint) => {
        respondValidated({
          preferences: preferences({
            city: '上海',
            position: ['服务员'],
            schedule_constraint: scheduleConstraint,
          }),
          schedule_constraint_citation: { quote: '晚上10点到早上6点' },
          reasoning: '班次越界',
        });

        const outcome = await service.extractAndSave(...scope, [
          { role: 'user', content: '上海服务员，晚上10点到早上6点' },
        ]);

        expect(outcome.llmDegraded).toBe(false);
        const saved = await savedPreferences();
        expect(saved?.city?.value).toBe('上海');
        expect(saved?.position?.value).toEqual(['服务员']);
        expect(saved?.schedule_constraint ?? null).toBeNull();
      },
    );

    it('丢弃不合契约的班次条件会告警，明细只含字段路径不含原值', async () => {
      const alertNotifier = { sendSimpleAlert: jest.fn().mockResolvedValue(true) };
      const facts = new SessionFactsService(
        redis as never,
        config as never,
        llm as never,
        sponge as never,
        systemConfig as never,
        undefined,
        undefined,
        alertNotifier as never,
      );
      respondValidated({
        preferences: preferences({
          schedule_constraint: { availableWindow: { start: '22:00', end: '06:00' } },
        }),
        schedule_constraint_citation: { quote: '晚上10点到早上6点' },
        reasoning: '班次越界',
      });

      await facts.extractAndSave(...scope, [{ role: 'user', content: '晚上10点到早上6点' }]);

      expect(alertNotifier.sendSimpleAlert).toHaveBeenCalledTimes(1);
      const [title, detail, level] = alertNotifier.sendSimpleAlert.mock.calls[0];
      expect(title).toContain('班次条件');
      expect(detail).toContain('availableWindow');
      expect(detail).not.toContain('22:00');
      expect(level).toBe('warning');
    });

    it('只改每周天数时保留已有意向班次文本', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({ schedule: '晚班', schedule_constraint: { includeAnyTags: ['evening'] } }),
      );
      llm.generateStructured.mockResolvedValue({
        output: {
          preferences: preferences({ schedule_constraint: { maxDaysPerWeek: 3 } }),
          schedule_constraint_citation: { quote: '一周最多3天' },
          reasoning: '补充周天数',
        },
      });

      await service.extractAndSave(...scope, [{ role: 'user', content: '一周最多3天' }]);

      const saved = await savedPreferences();
      expect(saved?.schedule?.value).toBe('晚班');
      expect(saved?.schedule_constraint?.value).toEqual({
        includeAnyTags: ['evening'],
        maxDaysPerWeek: 3,
      });
    });

    it('同一句给出日内条件与文本时，本轮抽到的意向班次和时间窗都保留', async () => {
      const message = '想做晚班17点后，一周最多3天';
      llm.generateStructured.mockResolvedValue({
        output: {
          preferences: preferences({
            schedule: '晚班',
            time_windows: ['17点后'],
            schedule_constraint: {
              includeAnyTags: ['evening'],
              availableWindow: { start: '17:00' },
              maxDaysPerWeek: 3,
            },
          }),
          schedule_constraint_citation: { quote: message },
          reasoning: '晚班+时段+周天数',
        },
      });

      await service.extractAndSave(...scope, [{ role: 'user', content: message }]);

      const saved = await savedPreferences();
      expect(saved?.schedule?.value).toBe('晚班');
      expect(saved?.time_windows?.value).toEqual(['17点后']);
      expect(saved?.schedule_constraint?.value).toMatchObject({ maxDaysPerWeek: 3 });
    });

    it.each(['有没有晚上6点到10点的班？', '我只能做早班吗？'])(
      '模型降级时规则轨不把询问「%s」写成持久班次条件',
      async (message) => {
        llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));

        await service.extractAndSave(
          ...scope,
          [{ role: 'user', content: message }],
          produceTurnHints([message], []),
        );

        expect((await savedPreferences())?.schedule_constraint ?? null).toBeNull();
      },
    );

    it('抽取降级时以工具已核验的本轮班次变更落盘，旧钟点文本随之作废', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({
          time_windows: ['18点后'],
          schedule_constraint: { onlyWeekends: true, availableWindow: { start: '18:00' } },
        }),
      );
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({ onlyWeekends: true, availableWindow: null });
      llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '时间不限了' }],
        ledger.drain().facts.turnHints,
      );

      const saved = await savedPreferences();
      expect(saved?.schedule_constraint).toMatchObject({
        value: { onlyWeekends: true, availableWindow: null },
        source: 'candidate_quote',
      });
      expect(saved?.schedule_constraint?.evidence).toContain('时间不限了');
      expect(saved?.time_windows).toMatchObject({ value: null });
    });

    it('抽取正常且判定无持续班次变更时（询问），工具本轮查询条件不沉淀', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({ schedule_constraint: { excludeTags: ['night'] } }),
      );
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({
        excludeTags: ['night'],
        includeAnyTags: ['early', 'morning'],
      });

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '有早班吗' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint?.value).toEqual({
        excludeTags: ['night'],
      });
    });

    it('抽取给出的班次变更未通过原话核验时，以工具已核验的本轮条件落盘', async () => {
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({ maxDaysPerWeek: 2 });
      llm.generateStructured.mockResolvedValue({
        output: {
          preferences: preferences({ schedule_constraint: { maxDaysPerWeek: 2 } }),
          schedule_constraint_citation: { quote: '候选人没说过的话' },
          reasoning: '周天数',
        },
      });

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '一周最多两天' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint).toMatchObject({
        value: { maxDaysPerWeek: 2 },
        source: 'candidate_quote',
      });
    });

    it('抽取只回显已保存条件且不带引文时，询问不经工具兜底沉淀', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({ schedule_constraint: { excludeTags: ['night'] } }),
      );
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({
        excludeTags: ['night'],
        includeAnyTags: ['early', 'morning'],
      });
      respondValidated({
        preferences: preferences({ schedule_constraint: { excludeTags: ['night'] } }),
        reasoning: '回显已有条件',
      });

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '有早班吗' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint?.value).toEqual({
        excludeTags: ['night'],
      });
    });

    it('抽取降级且本轮全是询问时，不用工具本轮查询条件落盘', async () => {
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({ availableWindow: { start: '18:00', end: '22:00' } });
      llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '有没有晚上6点到10点的班？' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint ?? null).toBeNull();
    });

    it('抽取的班次条件被契约拒绝时，陈述以工具已核验的本轮条件落盘', async () => {
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({
        availableWindow: { start: '22:00', end: '06:00', endDayOffset: 1 },
      });
      respondValidated({
        preferences: preferences({
          schedule_constraint: { availableWindow: { start: '22:00', end: '06:00' } },
        }),
        schedule_constraint_citation: { quote: '晚上10点到早上6点可以' },
        reasoning: '跨日漏写',
      });

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '晚上10点到早上6点可以' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint).toMatchObject({
        value: { availableWindow: { start: '22:00', end: '06:00', endDayOffset: 1 } },
        source: 'candidate_quote',
      });
      expect((await savedPreferences())?.schedule_constraint?.evidence).toContain('工具已核验');
    });

    it('抽取把“只做早班”只写成早班时，按固定映射补上上午班再保存', async () => {
      respondValidated({
        preferences: preferences({ schedule_constraint: { includeAnyTags: ['early'] } }),
        schedule_constraint_citation: { quote: '我只做早班' },
        reasoning: '只做早班',
      });

      await service.extractAndSave(...scope, [{ role: 'user', content: '我只做早班' }]);

      expect((await savedPreferences())?.schedule_constraint?.value).toEqual({
        includeAnyTags: ['early', 'morning'],
      });
    });

    it('抽取给出有效班次变更时以抽取为准，不再套用工具结果', async () => {
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({ maxDaysPerWeek: 2 });
      llm.generateStructured.mockResolvedValue({
        output: {
          preferences: preferences({ schedule_constraint: { maxDaysPerWeek: 3 } }),
          schedule_constraint_citation: { quote: '一周最多3天' },
          reasoning: '周天数',
        },
      });

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '一周最多3天' }],
        ledger.drain().facts.turnHints,
      );

      expect((await savedPreferences())?.schedule_constraint).toMatchObject({
        value: { maxDaysPerWeek: 3 },
        evidence: '一周最多3天',
      });
    });

    it('工具沿用既有条件未作变更时不改写记忆，也不清文本入口', async () => {
      const original = sessionFactValue<ScheduleConstraintFact>(
        { includeAnyTags: ['evening'] },
        {
          confidence: 'medium',
          source: 'candidate_quote',
          evidence: '只做晚班',
          extractedAt: '2026-08-01T00:00:00.000Z',
        },
      );
      const initial = softFacts({ schedule: '晚班' });
      initial.preferences.schedule_constraint = original;
      await service.saveFacts(...scope, initial);
      const ledger = createTurnLedger();
      ledger.recordScheduleConstraint({ includeAnyTags: ['evening'] });
      llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '帮我找上海的' }],
        ledger.drain().facts.turnHints,
      );

      const saved = await savedPreferences();
      expect(saved?.schedule_constraint).toEqual(original);
      expect(saved?.schedule?.value).toBe('晚班');
    });

    it('降级时规则轨「只上晚班」撤掉旧的晚班排除，不拼出自相矛盾的条件', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({ schedule_constraint: { excludeTags: ['evening'] } }),
      );
      llm.generateStructured.mockRejectedValue(new Error('LLM unavailable'));

      await service.extractAndSave(
        ...scope,
        [{ role: 'user', content: '我只上晚班' }],
        produceTurnHints(['我只上晚班'], []),
      );

      expect((await savedPreferences())?.schedule_constraint?.value).toEqual({
        includeAnyTags: ['evening'],
        excludeTags: [],
      });
    });

    it('本轮排除旧的正向标签时，从正向集合移除同名标签', async () => {
      await service.saveFacts(
        ...scope,
        softFacts({ schedule_constraint: { includeAnyTags: ['evening', 'night'] } }),
      );
      llm.generateStructured.mockResolvedValue({
        output: {
          preferences: preferences({ schedule_constraint: { excludeTags: ['evening'] } }),
          schedule_constraint_citation: { quote: '晚班不做了' },
          reasoning: '排除晚班',
        },
      });

      await service.extractAndSave(...scope, [{ role: 'user', content: '晚班不做了' }]);

      expect((await savedPreferences())?.schedule_constraint?.value).toEqual({
        includeAnyTags: ['night'],
        excludeTags: ['evening'],
      });
    });
  });

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

  it('收资逐格 medium 入档；同值不刷新，办结后升级 high', async () => {
    await expect(
      service.saveCollectionProgressFact(
        'corp-1',
        'user-1',
        'session-1',
        'name',
        sessionFactValue('兮兮', {
          confidence: 'high',
          source: 'candidate_quote',
          evidence: '收资表单第 1 格落定',
        }),
      ),
    ).rejects.toThrow('must be medium');

    const first = sessionFactValue('兮兮', {
      confidence: 'medium',
      source: 'candidate_quote',
      evidence: '收资表单第 1 格落定',
      extractedAt: '2026-08-25T10:00:00.000Z',
    });
    await service.saveCollectionProgressFact('corp-1', 'user-1', 'session-1', 'name', first);
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'name',
      sessionFactValue('兮兮', {
        confidence: 'medium',
        source: 'model',
        evidence: '收资表单第 1 格落定（同值重放不得刷新）',
        extractedAt: '2026-08-25T11:00:00.000Z',
      }),
    );

    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.interview_info.name).toEqual(
      first,
    );

    await service.saveCompletedCollectionFacts('corp-1', 'user-1', 'session-1', {
      name: sessionFactValue('兮兮', {
        confidence: 'high',
        source: 'candidate_quote',
        evidence: '收资表单办结',
      }),
    });
    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.interview_info.name).toEqual(
      expect.objectContaining({ value: '兮兮', confidence: 'high' }),
    );
  });

  it('既有 high 身份事实不被后到 medium 降级', async () => {
    const high = sessionFactValue('兮兮', {
      confidence: 'high',
      source: 'candidate_quote',
      evidence: '报名成功姓名',
    });
    await service.saveCompletedCollectionFacts('corp-1', 'user-1', 'session-1', { name: high });

    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'name',
      sessionFactValue('另一个名字', {
        confidence: 'medium',
        source: 'model',
        evidence: '收资表单第 1 格落定',
      }),
    );

    expect((await service.getFacts('corp-1', 'user-1', 'session-1'))?.interview_info.name).toEqual(
      high,
    );
  });

  it('学生身份再次公证后把同值 medium 升级 high，后续重放保留原信封', async () => {
    const meta = {
      source: 'candidate_quote' as const,
      evidence: '收资表单第 1 格落定（社会身份）',
    };
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'is_student',
      sessionFactValue(true, { ...meta, confidence: 'medium' }),
    );
    const confirmed = sessionFactValue(true, {
      ...meta,
      confidence: 'high' as const,
      extractedAt: '2026-10-09T00:00:00Z',
    });
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'is_student',
      confirmed,
    );
    await service.saveCollectionProgressFact('corp-1', 'user-1', 'session-1', 'is_student', {
      ...confirmed,
      extractedAt: '2026-10-09T01:00:00Z',
    });
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.interview_info.is_student,
    ).toEqual(confirmed);
    await expect(
      service.saveCollectionProgressFact(
        'corp-1',
        'user-1',
        'session-1',
        'is_student',
        sessionFactValue(false, { ...meta, confidence: 'high' }),
      ),
    ).rejects.toThrow('must be medium');
  });

  it('已公证身份改口撤销原有 high 学生事实，不写成 false', async () => {
    const meta = {
      source: 'candidate_quote' as const,
      confidence: 'high' as const,
      evidence: '收资表单第 1 格落定（社会身份）',
    };
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'is_student',
      sessionFactValue(true, meta),
    );
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'is_student',
      sessionFactValue(null, meta),
    );
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.interview_info.is_student,
    ).toBeNull();
  });

  it('半途弃单未走办结入口，逐格 medium 仍可由 consolidation 提拔进长期 Profile', async () => {
    await service.saveCollectionProgressFact(
      'corp-1',
      'user-1',
      'session-1',
      'education',
      sessionFactValue('本科', {
        confidence: 'medium',
        source: 'candidate_quote',
        evidence: '收资表单第 2 格落定',
      }),
    );
    const profileStore = { upsertProfileFacts: jest.fn().mockResolvedValue(undefined) };
    const longTerm = new LongTermService(profileStore as never);
    const facts = await service.getFacts('corp-1', 'user-1', 'session-1');

    await longTerm.writeFromConsolidation('corp-1', 'user-1', 'wecom-user-1', facts!, {
      sessionId: 'session-1',
      botImId: 'bot-1',
    });

    expect(profileStore.upsertProfileFacts).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'wecom-user-1',
      {
        education: expect.objectContaining({
          value: '本科',
          confidence: 'medium',
          source: 'candidate_quote',
          originSessionId: 'session-1',
        }),
      },
      undefined,
      {},
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
        source: 'system',
        evidence: '报名成功性别',
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

  it('正常提取时 labor_form_intent 覆盖 legacy preference 与规则提示', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ labor_form: '兼职' }),
        brand_intents: [],
        labor_form_intent: { intent: 'set', labor_form: '全职', quote: '我改找全职' },
        reasoning: '候选人明确改口',
      },
      modelId: 'test/extract',
    });

    await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '我改找全职' }],
      null,
      { kind: 'set', value: '暑假工' },
    );

    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.labor_form,
    ).toEqual(expect.objectContaining({ value: '全职', source: 'model', evidence: '我改找全职' }));
  });

  it('正常提取为 ignore 时不让 legacy preference 或规则覆盖旧用工形式', async () => {
    await service.saveFacts('corp-1', 'user-1', 'session-1', softFacts({ labor_form: '小时工' }));
    llm.generateStructured.mockResolvedValue({
      output: {
        preferences: preferences({ labor_form: '兼职' }),
        brand_intents: [],
        labor_form_intent: { intent: 'ignore', quote: '这是兼职岗位吗' },
        reasoning: '仅核对岗位事实',
      },
      modelId: 'test/extract',
    });

    await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '这是兼职岗位吗' }],
      null,
      { kind: 'set', value: '兼职' },
    );

    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.labor_form?.value,
    ).toBe('小时工');
  });

  it('提取降级时才使用显式用工形式规则兜底', async () => {
    llm.generateStructured.mockRejectedValueOnce(new Error('extract unavailable'));

    const outcome = await service.extractAndSave(
      'corp-1',
      'user-1',
      'session-1',
      [{ role: 'user', content: '我找全职' }],
      null,
      { kind: 'set', value: '全职' },
    );

    expect(outcome.llmDegraded).toBe(true);
    expect(
      (await service.getFacts('corp-1', 'user-1', 'session-1'))?.preferences.labor_form,
    ).toEqual(expect.objectContaining({ value: '全职', source: 'rule' }));
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

  it('城市确权后剔除白名单能反推为其他城市的区域/地点，白名单外的值保留', async () => {
    hash = {
      facts: softFacts({ district: ['栖霞', '我浦江'], location: ['陆家嘴', '某某小区'] }),
    };

    await expect(
      service.saveToolAttestedCity('corp-1', 'user-1', 'session-3', {
        city: '北京',
        source: 'geocode_unique',
        evidence: '地图解析',
      }),
    ).resolves.toBe('written');

    const facts = await service.getFacts('corp-1', 'user-1', 'session-3');
    expect(facts?.preferences.city?.value).toBe('北京');
    expect(facts?.preferences.district?.value).toEqual(['我浦江']);
    expect(facts?.preferences.district?.evidence).toContain('换城清理：移除 栖霞');
    expect(facts?.preferences.location?.value).toEqual(['某某小区']);
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
