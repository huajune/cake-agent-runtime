import { ToolRuntimeBuilderService } from '@agent/generator/preparation/tool-runtime-builder.service';

describe('ToolRuntimeBuilderService', () => {
  it('records a preloaded location-share anchor before exposing tools', () => {
    const registry = { buildForScenario: jest.fn().mockReturnValue({}) };
    const service = new ToolRuntimeBuilderService(registry as never);
    const runtime = service.build({
      params: { scenario: 'candidate-consultation', toolMode: 'none' } as never,
      normalizedInput: {
        truncatedMessages: [],
        currentUserMessage: '[位置消息] 121,31',
        currentTurnTexts: ['[位置消息] 121,31'],
        laborFormIntent: { kind: 'ignore' },
      },
      sources: {
        memory: {
          shortTerm: { sessionState: null, messageWindow: [] },
          longTerm: { semantic: { profile: null } },
          turnHints: null,
        },
        strategyConfig: { stage_goals: { stages: [] }, red_lines: { thresholds: [] } },
        turnBrandContext: { state: null, nicknameBrands: [] },
        visualSheetsByContent: undefined,
        geoAnchor: {
          longitude: 121,
          latitude: 31,
          city: '上海市',
          district: '徐汇区',
          evidence: '定位分享逆解析：上海市徐汇区',
        },
      } as never,
      resolved: {
        entryStage: null,
        ledgerSeed: {},
        bookingWorkOrderJobIds: [],
      } as never,
      normalizedMessages: [],
      conversationCorpusBlocks: [],
    });

    expect(runtime.ledger.geo.cityAttestation).toEqual(
      expect.objectContaining({ city: '上海市', source: 'location_share' }),
    );
    expect(runtime.tools).toEqual({});
  });
});
