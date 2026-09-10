import type { TurnSourceSnapshot } from '@agent/generator/preparation/turn-data-loader.service';
import type { BrandItem } from '@sponge/sponge.types';
import type { CorpusBlock } from '@shared-types/corpus.types';
import type { RecommendedJobSummary } from '@resolution/job/types';
import { finalizeVisualFactSheet } from '@resolution/signal/visual';
import { sessionFactsOf } from '../../../helpers/session-facts.fixture';
import {
  resolveCriticalTurnInstructions,
  resolveTurnContext,
} from '@agent/generator/preparation/turn-context-resolver';

/** 最小可解析回合；只用来断言单个投影，其余字段保持无害缺省。 */
function buildResolverInput(paramsOverride: Record<string, unknown> = {}) {
  return {
    params: { scenario: 'candidate-consultation', ...paramsOverride } as never,
    normalizedInput: {
      truncatedMessages: [{ role: 'user', content: '你好' }],
      currentUserMessage: '你好',
      currentTurnTexts: ['你好'],
      laborFormIntent: { kind: 'ignore' as const },
    },
    sources: {
      memory: {
        shortTerm: {
          stage: { currentStage: 'trust_building' },
          sessionState: null,
          messageWindow: [],
        },
        longTerm: { semantic: { profile: null } },
        turnHints: null,
      },
      booking: { state: 'none' },
      realtimeGroups: [],
      groupInventory: undefined,
      accountIdentity: { nickname: null, gender: null },
      strategyConfig: {
        stage_goals: { stages: [{ stage: 'trust_building' }] },
        red_lines: { thresholds: [] },
      },
      visualSheetsByContent: undefined,
      turnBrandContext: {
        state: { currentBrand: null, excludedBrands: [] },
        nicknameBrands: [],
        persisted: false,
      },
      geoAnchor: undefined,
      warnings: [],
    } as never,
    normalizedMessages: [{ role: 'user' as const, content: '你好' }],
    conversationCorpusBlocks: [],
    injectionAssessment: { safe: true, detected: false },
    nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
  };
}

describe('resolveTurnContext', () => {
  it('seeds current literal brand mentions even when the session brand state is empty', () => {
    const input = buildResolverInput();
    Object.assign(input.sources, { brandCatalog: [{ id: 1, name: '肯德基', aliases: ['KFC'] }] });
    input.conversationCorpusBlocks = [
      { id: 'current', domain: 'evidence', role: 'user', content: 'KFC' },
    ];
    expect(resolveTurnContext(input).ledgerSeed.mentionedBrands).toEqual(new Set(['肯德基']));
  });

  it('uses the returning-user stage when the short-term stage expired', () => {
    const result = resolveTurnContext({
      params: {
        scenario: 'candidate-consultation',
        contactName: '候选人',
      } as never,
      normalizedInput: {
        truncatedMessages: [{ role: 'user', content: '还有岗位吗' }],
        currentUserMessage: '还有岗位吗',
        currentTurnTexts: ['还有岗位吗'],
        laborFormIntent: { kind: 'ignore' },
      },
      sources: {
        memory: {
          shortTerm: {
            stage: { currentStage: null },
            sessionState: null,
            messageWindow: [],
          },
          longTerm: {
            semantic: {
              profile: {
                name: {
                  value: '张三',
                  confidence: 'high',
                  source: 'user',
                  evidence: '用户提供',
                  updatedAt: '2026-09-01T00:00:00.000Z',
                },
              },
            },
          },
          turnHints: null,
        },
        booking: { state: 'none' },
        realtimeGroups: [],
        groupInventory: undefined,
        accountIdentity: { nickname: null, gender: null },
        strategyConfig: {
          stage_goals: {
            stages: [{ stage: 'trust_building' }, { stage: 'job_consultation' }],
          },
          red_lines: { thresholds: [] },
        },
        visualSheetsByContent: undefined,
        turnBrandContext: {
          state: { currentBrand: null, excludedBrands: [] },
          nicknameBrands: [],
          persisted: false,
        },
        geoAnchor: undefined,
        warnings: [],
      } as never,
      normalizedMessages: [{ role: 'user', content: '还有岗位吗' }],
      conversationCorpusBlocks: [],
      injectionAssessment: { safe: true, detected: false },
      nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
    });

    expect(result.entryStage).toBe('job_consultation');
    expect(result.promptModel.strategy.currentStage?.stage).toBe('job_consultation');
    expect(result.memorySnapshot.currentStage).toBe('job_consultation');
    expect(result.toolModel.selection).toEqual({
      scenario: 'candidate-consultation',
      mode: 'scenario',
      allowedToolNames: undefined,
    });
    expect(result.ledgerSeed).toEqual(
      expect.objectContaining({
        laborFormIntent: { kind: 'ignore' },
        collectedFields: expect.any(Object),
        geoSignalCities: new Set(),
      }),
    );
  });

  /** 通道判据回归：小组级 API 的 1:1 私聊不得拿到群聊规范。 */
  it.each([
    { label: '小组级 API 的私聊', params: { apiType: 'group' as const }, expected: 'private' },
    { label: '企业级 API 的私聊', params: { apiType: 'enterprise' as const }, expected: 'private' },
    { label: '真实群会话', params: { imRoomId: 'room-1' }, expected: 'group' },
    {
      label: '小组级 API 的群会话',
      params: { apiType: 'group' as const, imRoomId: 'room-1' },
      expected: 'group',
    },
  ])('derives channelType from imRoomId, not apiType（$label）', ({ params, expected }) => {
    const result = resolveTurnContext(buildResolverInput(params));
    expect(result.promptModel.channelType).toBe(expected);
  });

  it('keeps the first-stage fallback for a brand-new user when the stage expired', () => {
    // 老用户回访兜底到 job_consultation 有测试守着；新用户不能被同一条兜底带走。
    const input = buildResolverInput();
    (
      input.sources as never as {
        memory: { shortTerm: { stage: { currentStage: string | null } } };
      }
    ).memory.shortTerm.stage.currentStage = null;

    const result = resolveTurnContext(input);

    expect(result.entryStage).toBe('trust_building');
  });

  describe('resolveCriticalTurnInstructions 的 combined 近邻窗口（议题 6-1）', () => {
    // 生产形态：runner 只构造当前这一条 user 消息，历史全在 memory 窗口里，
    // 所以 combined 规则必须吃 normalizedMessages 而不是本批 truncatedMessages。
    const withWindow = (window: Array<{ role: 'user' | 'assistant'; content: string }>) =>
      resolveCriticalTurnInstructions({
        currentUserMessage: '再帮我约一次',
        normalizedMessages: window,
      });

    it('triggers post_interview_no_rebook from short-term history', () => {
      const guards = withWindow([
        { role: 'assistant', content: '恭喜你面试通过了，门店那边会联系你安排入职' },
        { role: 'user', content: '再帮我约一次' },
      ]);

      expect(guards.join('\n')).toContain('近邻上下文显示候选人已在面试/入职');
    });

    it('does not trigger it when the history carries no such state', () => {
      const guards = withWindow([
        { role: 'assistant', content: '你好，想找哪一类岗位？' },
        { role: 'user', content: '再帮我约一次' },
      ]);

      expect(guards.join('\n')).not.toContain('近邻上下文显示候选人已在面试/入职');
    });
  });
});

const catalog: BrandItem[] = [
  { id: 1, name: '肯德基', aliases: ['KFC'] },
  { id: 2, name: '麦当劳', aliases: ['金拱门'] },
  { id: 3, name: 'M Stand', aliases: ['mstand'] },
  { id: 4, name: '瑞幸咖啡', aliases: ['瑞幸'] },
  { id: 5, name: '小龙坎', aliases: ['小龙'] },
  { id: 6, name: '小龙翻大江', aliases: ['小龙'] },
  { id: 7, name: '全家', aliases: [] },
];

function sources(): TurnSourceSnapshot {
  return {
    brandCatalog: catalog,
    memory: {
      shortTerm: { sessionState: null, messageWindow: [], stage: { currentStage: null } },
      longTerm: { semantic: { profile: null } },
      turnHints: null,
    },
    turnBrandContext: {
      state: { currentBrand: null, excludedBrands: [] },
      nicknameBrands: [],
      persisted: false,
    },
    booking: { state: 'none' },
    warnings: [],
    visualSheetsByContent: new Map(),
  } as unknown as TurnSourceSnapshot;
}

function job(brandName: string, jobId = 1): RecommendedJobSummary {
  return { jobId, brandName } as RecommendedJobSummary;
}

function collect(
  snapshot: TurnSourceSnapshot,
  blocks: CorpusBlock[] = [],
  contactName?: string,
): ReadonlySet<string> | null {
  const input = buildResolverInput({ contactName });
  return resolveTurnContext({
    ...input,
    sources: { ...(input.sources as TurnSourceSnapshot), ...snapshot },
    conversationCorpusBlocks: blocks,
  }).ledgerSeed.mentionedBrands as ReadonlySet<string> | null;
}

function message(content: string, role: 'user' | 'assistant' = 'user'): CorpusBlock {
  return { id: 'message', domain: 'evidence', role, content };
}

describe('mentioned brands at turn start', () => {
  it('has a reliable empty set for the first-contact incident, excluding teaching/tool echoes', () => {
    expect(
      collect(sources(), [
        message('我是朱振亿'),
        message('日结的'),
        message('还有吗'),
        { id: 'rules', domain: 'teaching', role: 'system', content: '示例：肯德基' },
        { id: 'error', domain: 'tool_result', role: 'tool', content: '查询参数：麦当劳' },
      ]),
    ).toEqual(new Set());
  });

  it.each(['想找KFC', '不要肯德基', '以前在肯德基上班'])(
    'keeps literal mention %s with empty state',
    (text) => {
      expect(collect(sources(), [message(text)])).toEqual(new Set(['肯德基']));
    },
  );

  it('includes assistant/human recommendations and quoted messages', () => {
    expect(
      collect(sources(), [
        message('可以看看麦当劳', 'assistant'),
        message('引用：\n> 肯德基还在招\n还有吗'),
      ]),
    ).toEqual(new Set(['麦当劳', '肯德基']));
  });

  it('keeps every ambiguous catalog candidate without choosing an intent', () => {
    expect(collect(sources(), [message('小龙')])).toEqual(new Set(['小龙坎', '小龙翻大江']));
  });

  it('uses the existing category expansion for coffee', () => {
    const brands = collect(sources(), [message('咖啡兼职')]);
    expect(brands?.has('mstand')).toBe(true);
    expect(brands?.has('瑞幸咖啡')).toBe(true);
  });

  it('expands categories independently of another mentioned brand', () => {
    expect(collect(sources(), [message('肯德基不要了，我想找咖啡')])).toEqual(
      new Set(['肯德基', 'mstand', '瑞幸咖啡']),
    );
  });

  it('keeps short canonical names embedded in a real message', () => {
    expect(collect(sources(), [message('想去全家上班')])).toEqual(new Set(['全家']));
  });

  it('keeps location-share brand mentions without interpreting them as preference', () => {
    expect(
      collect(sources(), [message('[位置分享] 肯德基（中心店） [经纬度:121.1,31.1]')]),
    ).toEqual(new Set(['肯德基']));
  });

  it('includes the raw nickname and both current and excluded session brands', () => {
    const snapshot = sources();
    snapshot.turnBrandContext.state = {
      currentBrand: { canonicalName: '麦当劳', brandId: 2 },
      excludedBrands: [{ canonicalName: 'M Stand', brandId: 3 }],
    };
    expect(collect(snapshot, [], '肯德基-小朱')).toEqual(new Set(['肯德基', '麦当劳', 'mstand']));
  });

  it('includes short-term brand IDs and archived long-term brand values', () => {
    const snapshot = sources();
    snapshot.memory.shortTerm.sessionState = {
      facts: sessionFactsOf({ preferences: { brand_ids: [1] } }),
    } as typeof snapshot.memory.shortTerm.sessionState;
    snapshot.memory.longTerm.semantic.jobIntent = {
      brands: {
        value: ['金拱门'],
        confidence: 'medium',
        source: 'archive',
        evidence: '历史意向',
        updatedAt: '',
      },
    };
    expect(collect(snapshot)).toEqual(new Set(['肯德基', '麦当劳']));
  });

  it('includes all three historical job pools used by archive.recentBrandPool', () => {
    const snapshot = sources();
    snapshot.memory.shortTerm.sessionState = {
      presentedJobs: [job('KFC')],
      lastCandidatePool: [job('麦当劳')],
      currentFocusJob: job('M Stand'),
    } as typeof snapshot.memory.shortTerm.sessionState;
    expect(collect(snapshot)).toEqual(new Set(['肯德基', '麦当劳', 'mstand']));
  });

  it('includes valid visual fields even when the description omitted the brand', () => {
    const snapshot = sources();
    snapshot.visualSheetsByContent = new Map([
      [
        '截图',
        finalizeVisualFactSheet(
          { kind: 'job_posting', fields: [{ key: 'brand', value: 'KFC' }] },
          '招聘岗位',
        ),
      ],
    ]);
    expect(collect(snapshot)).toEqual(new Set(['肯德基']));
  });

  it.each(['memory', 'brand', 'visual_facts', 'brand_catalog', 'missing_catalog', 'empty_catalog'])(
    'returns unknown for unavailable source %s',
    (source) => {
      const snapshot = sources();
      if (source === 'memory') snapshot.memory._warnings = ['short-term load failed'];
      else if (source === 'missing_catalog') snapshot.brandCatalog = null;
      else if (source === 'empty_catalog') snapshot.brandCatalog = [];
      else
        snapshot.warnings = [
          { source, message: 'failed' } as TurnSourceSnapshot['warnings'][number],
        ];
      expect(collect(snapshot, [message('肯德基')])).toBeNull();
    },
  );
});
