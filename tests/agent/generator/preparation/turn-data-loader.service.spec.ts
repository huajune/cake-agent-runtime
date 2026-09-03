import { CallerKind } from '@enums/agent.enum';
import {
  buildGroupInventoryView,
  TurnDataLoaderService,
} from '@agent/generator/preparation/turn-data-loader.service';
import { GroupInventorySection } from '@agent/generator/context/sections/working/group-inventory.section';
import { sessionFactsOf } from '../../../helpers/session-facts.fixture';

describe('TurnDataLoaderService', () => {
  it('builds a typed, high-confidence city inventory view for the rendering section', () => {
    const memory = {
      shortTerm: {
        sessionState: {
          facts: sessionFactsOf({
            preferences: {
              city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
            },
          }),
        },
      },
    } as never;
    const view = buildGroupInventoryView(
      memory,
      [
        {
          imRoomId: 'r1',
          groupName: '上海餐饮群',
          city: '上海市',
          industry: '餐饮',
          memberCount: 100,
        },
        {
          imRoomId: 'r2',
          groupName: '上海餐饮群2',
          city: '上海',
          industry: '餐饮',
          memberCount: 250,
        },
      ] as never,
      200,
    );

    expect(view).toEqual({
      city: '上海',
      industries: [{ industry: '餐饮', groupCount: 2, availableCount: 1 }],
    });
    expect(
      new GroupInventorySection().build({ groupInventory: view } as never)[0]?.content,
    ).toContain('可用 1/2');
  });

  it('does not turn a failed group source into a false empty-inventory claim', () => {
    const memory = {
      shortTerm: {
        sessionState: {
          facts: sessionFactsOf({
            preferences: {
              city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
            },
          }),
        },
      },
    } as never;
    expect(buildGroupInventoryView(memory, undefined, 200)).toBeUndefined();
  });

  it('loads one shared source snapshot and derives its dependent views from it', async () => {
    const memory = buildMemory();
    const groups = [
      {
        imRoomId: 'room-1',
        groupName: '上海餐饮群',
        city: '上海',
        industry: '餐饮',
        memberCount: 100,
      },
    ];
    const booking = {
      loadPointer: jest.fn().mockResolvedValue({ state: 'none' }),
      enrichOutOfBand: jest.fn().mockResolvedValue({ state: 'none' }),
    };
    const memoryService = { onTurnStart: jest.fn().mockResolvedValue(memory) };
    const sponge = { fetchBrandList: jest.fn().mockResolvedValue([]) };
    const groupResolver = { resolveGroups: jest.fn().mockResolvedValue(groups) };
    const groupMembership = { listUserRooms: jest.fn().mockResolvedValue(['room-1']) };
    const accountIdentity = {
      resolveAgentAccountIdentity: jest.fn().mockResolvedValue({ nickname: '小蛋', gender: '女' }),
    };
    const brand = {
      deriveTurnBrandContext: jest.fn().mockResolvedValue({
        state: { currentBrand: null, excludedBrands: [] },
        persisted: false,
        nicknameBrands: [],
      }),
    };
    const enrichment = { enrich: jest.fn().mockImplementation(async (snapshot) => snapshot) };
    const chatSession = { getVisualFacts: jest.fn().mockResolvedValue([]) };
    const strategyRecord = { stage_goals: { stages: [] }, red_lines: { thresholds: [] } };
    const strategy = { getActiveConfig: jest.fn().mockResolvedValue(strategyRecord) };
    const config = { get: jest.fn().mockReturnValue('200') };
    const tracer = { emit: jest.fn() };
    const service = new TurnDataLoaderService(
      booking as never,
      memoryService as never,
      sponge as never,
      groupResolver as never,
      groupMembership as never,
      accountIdentity as never,
      brand as never,
      enrichment as never,
      chatSession as never,
      strategy as never,
      config as never,
      undefined,
      tracer as never,
    );

    const snapshot = await service.load(
      {
        callerKind: CallerKind.WECOM,
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: '上海有餐饮工作吗' }],
        imContactId: 'contact-1',
        botImId: 'bot-1',
        contactName: '候选人',
        strategySource: 'testing',
      },
      {
        truncatedMessages: [{ role: 'user', content: '上海有餐饮工作吗' }],
        currentUserMessage: '上海有餐饮工作吗',
        currentTurnTexts: ['上海有餐饮工作吗'],
        laborFormIntent: { kind: 'unknown' } as never,
      },
    );

    expect(memoryService.onTurnStart).toHaveBeenCalledWith(
      'corp-1',
      'user-1',
      'session-1',
      '上海有餐饮工作吗',
      expect.objectContaining({ includeShortTerm: true }),
    );
    expect(groupResolver.resolveGroups).toHaveBeenCalledTimes(1);
    expect(groupMembership.listUserRooms).toHaveBeenCalledWith('contact-1', expect.anything());
    expect(strategy.getActiveConfig).toHaveBeenCalledWith('testing');
    expect(booking.enrichOutOfBand).toHaveBeenCalledWith(
      { state: 'none' },
      memory,
      expect.objectContaining({ sessionId: 'session-1' }),
      '上海有餐饮工作吗',
    );
    expect(snapshot).toEqual(
      expect.objectContaining({
        memory,
        booking: { state: 'none' },
        realtimeGroups: [{ groupName: '上海餐饮群', city: '上海' }],
        groupInventory: {
          city: '上海',
          industries: [{ industry: '餐饮', groupCount: 1, availableCount: 1 }],
        },
        accountIdentity: { nickname: '小蛋', gender: '女' },
        strategyConfig: strategyRecord,
        warnings: [],
      }),
    );
    expect(snapshot.sourceObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'memory', status: 'success' }),
        expect.objectContaining({ source: 'strategy', status: 'success' }),
        expect.objectContaining({ source: 'groups', status: 'success' }),
      ]),
    );
    expect(
      snapshot.sourceObservations.every(
        (source) => source.durationMs >= 0 && Boolean(source.observedAt),
      ),
    ).toBe(true);
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_data_sources',
        status: 'success',
        sources: snapshot.sourceObservations,
      }),
    );
  });

  it('keeps optional source failures explicit without rejecting the turn', async () => {
    const memory = buildMemory();
    const booking = {
      loadPointer: jest.fn().mockResolvedValue({ state: 'none' }),
      enrichOutOfBand: jest.fn().mockResolvedValue({ state: 'none' }),
    };
    const tracer = { emit: jest.fn() };
    const service = new TurnDataLoaderService(
      booking as never,
      { onTurnStart: jest.fn().mockResolvedValue(memory) } as never,
      { fetchBrandList: jest.fn().mockResolvedValue([]) } as never,
      { resolveGroups: jest.fn().mockRejectedValue(new Error('group source down')) } as never,
      { listUserRooms: jest.fn() } as never,
      {
        resolveAgentAccountIdentity: jest.fn().mockRejectedValue(new Error('identity down')),
      } as never,
      {
        deriveTurnBrandContext: jest.fn().mockRejectedValue(new Error('brand down')),
      } as never,
      { enrich: jest.fn().mockImplementation(async (snapshot) => snapshot) } as never,
      { getVisualFacts: jest.fn().mockRejectedValue(new Error('visual source down')) } as never,
      {
        getActiveConfig: jest
          .fn()
          .mockResolvedValue({ stage_goals: { stages: [] }, red_lines: { thresholds: [] } }),
      } as never,
      { get: jest.fn().mockReturnValue('200') } as never,
      undefined,
      tracer as never,
    );

    const snapshot = await service.load(
      {
        callerKind: CallerKind.WECOM,
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: '你好' }],
      },
      {
        truncatedMessages: [{ role: 'user', content: '你好' }],
        currentUserMessage: '你好',
        currentTurnTexts: ['你好'],
        laborFormIntent: { kind: 'unknown' } as never,
      },
    );

    expect(snapshot.groupInventory).toBeUndefined();
    expect(snapshot.accountIdentity).toEqual({ nickname: null, gender: null });
    expect(snapshot.turnBrandContext).toEqual({
      state: { currentBrand: null, excludedBrands: [] },
      persisted: false,
      nicknameBrands: [],
    });
    expect(snapshot.visualSheetsByContent).toBeUndefined();
    expect(snapshot.warnings.map((warning) => warning.source).sort()).toEqual([
      'account_identity',
      'brand',
      'groups',
      'visual_facts',
    ]);
    expect(snapshot.sourceObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'groups', status: 'degraded' }),
        expect.objectContaining({ source: 'account_identity', status: 'degraded' }),
        expect.objectContaining({ source: 'brand', status: 'degraded' }),
        expect.objectContaining({ source: 'visual_facts', status: 'degraded' }),
        // 上游群资源失败 ⇒ 成员核验根本没跑过，不能落成「已核验：不在任何群」。
        expect.objectContaining({ source: 'group_membership', status: 'degraded' }),
      ]),
    );
  });

  it('marks the memory source degraded when the short-term window failed to load', async () => {
    const memory = {
      ...(buildMemory() as Record<string, unknown>),
      _warnings: ['shortTerm: redis timeout'],
    };
    const tracer = { emit: jest.fn() };
    const service = new TurnDataLoaderService(
      {
        loadPointer: jest.fn().mockResolvedValue({ state: 'none' }),
        enrichOutOfBand: jest.fn().mockResolvedValue({ state: 'none' }),
      } as never,
      { onTurnStart: jest.fn().mockResolvedValue(memory) } as never,
      { fetchBrandList: jest.fn().mockResolvedValue([]) } as never,
      { resolveGroups: jest.fn().mockResolvedValue([]) } as never,
      { listUserRooms: jest.fn().mockResolvedValue([]) } as never,
      {
        resolveAgentAccountIdentity: jest.fn().mockResolvedValue({ nickname: null, gender: null }),
      } as never,
      {
        deriveTurnBrandContext: jest.fn().mockResolvedValue({
          state: { currentBrand: null, excludedBrands: [] },
          persisted: false,
          nicknameBrands: [],
        }),
      } as never,
      { enrich: jest.fn().mockImplementation(async (snapshot) => snapshot) } as never,
      { getVisualFacts: jest.fn().mockResolvedValue([]) } as never,
      {
        getActiveConfig: jest
          .fn()
          .mockResolvedValue({ stage_goals: { stages: [] }, red_lines: { thresholds: [] } }),
      } as never,
      { get: jest.fn().mockReturnValue('200') } as never,
      undefined,
      tracer as never,
    );

    const snapshot = await service.load(
      {
        callerKind: CallerKind.WECOM,
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: '你好' }],
      } as never,
      {
        truncatedMessages: [{ role: 'user', content: '你好' }],
        currentUserMessage: '你好',
        currentTurnTexts: ['你好'],
        laborFormIntent: { kind: 'ignore' } as never,
      },
    );

    // 记忆域的失败既不抛错也不记 warning，只挂 `_warnings`；不显式认领就会被当成 success，
    // 「Agent 零历史作答」这类事故在档案里将完全看不出来。
    expect(snapshot.sourceObservations).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: 'memory', status: 'degraded' })]),
    );
  });

  it('waits for in-flight sources before emitting the failure event', async () => {
    const tracer = { emit: jest.fn() };
    let resolveSlowMemory: (value: unknown) => void = () => {};
    const slowMemory = new Promise((resolve) => {
      resolveSlowMemory = resolve;
    });
    const service = new TurnDataLoaderService(
      {
        loadPointer: jest.fn().mockResolvedValue({ state: 'none' }),
        enrichOutOfBand: jest.fn().mockResolvedValue({ state: 'none' }),
      } as never,
      { onTurnStart: jest.fn().mockReturnValue(slowMemory) } as never,
      { fetchBrandList: jest.fn().mockResolvedValue([]) } as never,
      { resolveGroups: jest.fn().mockResolvedValue([]) } as never,
      { listUserRooms: jest.fn().mockResolvedValue([]) } as never,
      {
        resolveAgentAccountIdentity: jest.fn().mockResolvedValue({ nickname: null, gender: null }),
      } as never,
      {
        deriveTurnBrandContext: jest.fn().mockResolvedValue({
          state: { currentBrand: null, excludedBrands: [] },
          persisted: false,
          nicknameBrands: [],
        }),
      } as never,
      { enrich: jest.fn().mockImplementation(async (snapshot) => snapshot) } as never,
      { getVisualFacts: jest.fn().mockResolvedValue([]) } as never,
      // 策略先崩，memory 还挂着——档案必须两个源都有，否则排障会把慢源读成「没参与本轮」。
      { getActiveConfig: jest.fn().mockRejectedValue(new Error('strategy down')) } as never,
      { get: jest.fn().mockReturnValue('200') } as never,
      undefined,
      tracer as never,
    );

    const load = service.load(
      {
        callerKind: CallerKind.WECOM,
        corpId: 'corp-1',
        userId: 'user-1',
        sessionId: 'session-1',
        messages: [{ role: 'user', content: '你好' }],
      } as never,
      {
        truncatedMessages: [{ role: 'user', content: '你好' }],
        currentUserMessage: '你好',
        currentTurnTexts: ['你好'],
        laborFormIntent: { kind: 'ignore' } as never,
      },
    );
    const assertion = expect(load).rejects.toThrow('strategy down');
    resolveSlowMemory(buildMemory());
    await assertion;

    const failureEvent = tracer.emit.mock.calls
      .map(([event]) => event)
      .find((event) => event.type === 'turn_data_sources' && event.status === 'failure');
    expect(failureEvent.sources.map((source: { source: string }) => source.source)).toEqual(
      expect.arrayContaining(['memory', 'strategy']),
    );
  });
});

function buildMemory() {
  return {
    shortTerm: {
      messageWindow: [],
      sessionState: {
        facts: sessionFactsOf({
          preferences: {
            city: { value: '上海', confidence: 'high', evidence: 'explicit_city' },
          },
        }),
      },
      stage: { currentStage: 'job_consultation' },
    },
    longTerm: { semantic: { profile: null } },
    turnHints: null,
  } as never;
}
