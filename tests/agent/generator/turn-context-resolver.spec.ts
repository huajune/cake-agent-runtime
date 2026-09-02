import { resolveTurnContext } from '@agent/generator/preparation/turn-context-resolver';

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
      nowMs: Date.parse('2026-09-02T00:00:00.000Z'),
    });

    expect(result.entryStage).toBe('job_consultation');
    expect(result.composeParams.currentStage).toBe('job_consultation');
    expect(result.memorySnapshot.currentStage).toBe('job_consultation');
  });
});
