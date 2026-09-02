import { ToolRuntimeBuilderService } from '@agent/generator/preparation/tool-runtime-builder.service';

describe('ToolRuntimeBuilderService', () => {
  it('records a preloaded location-share anchor before exposing tools', () => {
    const registry = { buildForScenario: jest.fn().mockReturnValue({}) };
    const service = new ToolRuntimeBuilderService(registry as never);
    const runtime = service.build({
      resolved: {
        entryStage: null,
        ledgerSeed: {},
        initialGeoResolution: {
          longitude: 121,
          latitude: 31,
          city: '上海市',
          district: '徐汇区',
          evidence: '定位分享逆解析：上海市徐汇区',
        },
        toolModel: {
          selection: { scenario: 'candidate-consultation', mode: 'none' },
          session: {},
          archive: {},
          turnInput: {},
          runtime: {},
          turnStartRecalledJobIds: [],
        },
      } as never,
    });

    expect(runtime.ledger.geo.cityAttestation).toEqual(
      expect.objectContaining({ city: '上海市', source: 'location_share' }),
    );
    expect(runtime.tools).toEqual({});
    expect(runtime.availableToolCount).toBe(0);
    expect(runtime.activeToolCount).toBe(0);
  });

  it('locks the active tool set after mode and explicit authorization are applied', () => {
    const registry = {
      buildForScenario: jest.fn().mockReturnValue({
        duliday_job_list: {},
        recall_history: {},
        duliday_interview_booking: {},
      }),
    };
    const service = new ToolRuntimeBuilderService(registry as never);
    const runtime = service.build({
      resolved: {
        ledgerSeed: {},
        toolModel: {
          selection: {
            scenario: 'candidate-consultation',
            mode: 'readonly',
            allowedToolNames: ['duliday_job_list', 'duliday_interview_booking'],
          },
          session: {},
          archive: {},
          turnInput: {},
          runtime: {},
          turnStartRecalledJobIds: [],
        },
      } as never,
    });

    expect(Object.keys(runtime.tools)).toEqual(['duliday_job_list']);
    expect(runtime.availableToolCount).toBe(3);
    expect(runtime.activeToolCount).toBe(1);
  });
});
