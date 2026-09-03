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
