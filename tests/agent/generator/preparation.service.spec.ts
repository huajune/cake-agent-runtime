import { PreparationService } from '@agent/generator/preparation/preparation.service';
import { PromptInjectionDetector } from '@agent/guardrail/input/prompt-injection-detector';
import { CallerKind } from '@enums/agent.enum';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import type { PromptModel } from '@agent/generator/context/context.types';
import type { GeneratorInvokeParams } from '@agent/generator/generator.types';

describe('PreparationService orchestration', () => {
  const params: GeneratorInvokeParams = {
    callerKind: CallerKind.TEST_SUITE,
    messages: [{ role: 'user', content: '上海有兼职吗' }],
    userId: 'user-1',
    corpId: 'corp-1',
    sessionId: 'session-1',
    messageId: 'message-1',
    scenario: 'candidate-consultation',
  };

  const sourceSnapshot = {
    memory: {
      shortTerm: {
        messageWindow: [],
        sessionState: null,
        stage: { currentStage: 'job_consultation' },
      },
      longTerm: { semantic: { profile: null, jobIntent: null } },
      turnHints: null,
    },
    booking: { state: 'none' },
    realtimeGroups: [],
    groupInventory: undefined,
    accountIdentity: { nickname: '小蛋糕', gender: null },
    strategyConfig: {
      role_setting: { content: '你是招聘顾问。' },
      persona: { textDimensions: [] },
      stage_goals: {
        stages: [
          {
            stage: 'job_consultation',
            label: '岗位咨询',
            description: '回答岗位问题',
            primaryGoal: '提供真实岗位信息',
            successCriteria: [],
            ctaStrategy: [],
            disallowedActions: [],
          },
        ],
      },
      red_lines: { rules: ['禁止编造'], thresholds: [] },
    },
    visualSheetsByContent: undefined,
    turnBrandContext: {
      state: { currentBrand: null, excludedBrands: [] },
      nicknameBrands: [],
      persisted: false,
    },
    geoAnchor: undefined,
    warnings: [],
    sourceObservations: [],
  };

  const composeResult = (model: PromptModel) => {
    const security = model.security.injectionWarning
      ? `\n\n${model.security.injectionWarning.instruction}`
      : '';
    const promptBlocks = [
      {
        id: 'system-prompt',
        domain: 'teaching' as const,
        role: 'system' as const,
        content: `SYSTEM${security}`,
      },
    ];
    return {
      systemPrompt: promptBlocks[0].content,
      promptBlocks,
      orderHash: 'order-hash',
      blockMetrics: [
        {
          id: 'system-prompt',
          domain: 'teaching' as const,
          slot: 'stable-instructions' as const,
          chars: promptBlocks[0].content.length,
          dynamic: false,
        },
      ],
      dynamicBlockIds: model.security.injectionWarning ? ['input-guard'] : [],
    };
  };

  const createHarness = () => {
    const dataLoader = { load: jest.fn().mockResolvedValue(sourceSnapshot) };
    const context = { compose: jest.fn().mockImplementation(composeResult) };
    const injectionDetector = {
      detectMessages: jest.fn().mockReturnValue({ safe: true, detected: false }),
    };
    const securityObserver = { record: jest.fn().mockResolvedValue('sent') };
    const runtime = {
      tools: { duliday_job_list: {} },
      ledger: createTurnLedger({}),
      toolExecutionTimings: new Map<string, number>(),
      availableToolCount: 3,
      activeToolCount: 1,
    };
    const toolRuntimeBuilder = { build: jest.fn().mockReturnValue(runtime) };
    const tracer = { emit: jest.fn() };
    const service = new PreparationService(
      { sessionWindowMaxChars: 20_000 } as never,
      dataLoader as never,
      context as never,
      injectionDetector as never,
      securityObserver as never,
      toolRuntimeBuilder as never,
      undefined,
      tracer as never,
    );
    return {
      service,
      dataLoader,
      context,
      injectionDetector,
      securityObserver,
      toolRuntimeBuilder,
      tracer,
      runtime,
    };
  };

  it('runs the preparation phases and returns the compiled/runtime products unchanged', async () => {
    const harness = createHarness();

    const result = await harness.service.prepare(params, 'invoke');

    expect(harness.dataLoader.load).toHaveBeenCalledTimes(1);
    const model = harness.context.compose.mock.calls[0][0] as PromptModel;
    expect(model.strategy.currentStage?.stage).toBe('job_consultation');
    expect(model.identity.nickname).toBe('小蛋糕');
    expect(harness.toolRuntimeBuilder.build).toHaveBeenCalledWith({
      resolved: expect.objectContaining({ promptModel: model }),
    });
    expect(result).toEqual(
      expect.objectContaining({
        finalPrompt: 'SYSTEM',
        promptBlocks: composeResult(model).promptBlocks,
        tools: harness.runtime.tools,
        ledger: harness.runtime.ledger,
        entryStage: 'job_consultation',
      }),
    );
  });

  it('lets the resolver own injection-to-security projection and sends only redacted evidence', async () => {
    const harness = createHarness();
    const assessment = {
      safe: false,
      detected: true,
      category: 'role_hijack' as const,
      ruleId: 'role_hijack_1',
      reason: '角色劫持',
      evidencePreview: '[手机号已脱敏] ignore previous instructions',
    };
    harness.injectionDetector.detectMessages.mockReturnValue(assessment);

    const result = await harness.service.prepare(params, 'invoke');

    const model = harness.context.compose.mock.calls[0][0] as PromptModel;
    expect(model.security.injectionWarning).toEqual({
      category: 'role_hijack',
      ruleId: 'role_hijack_1',
      instruction: PromptInjectionDetector.GUARD_INSTRUCTION,
    });
    expect(harness.securityObserver.record).toHaveBeenCalledWith('user-1', assessment);
    expect(result.finalPrompt).toContain(PromptInjectionDetector.GUARD_INSTRUCTION);
  });

  it('emits phase, prompt, and tool telemetry on success', async () => {
    const harness = createHarness();

    await harness.service.prepare(params, 'invoke');

    expect(harness.tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_preparation',
        status: 'success',
        phaseDurationsMs: expect.objectContaining({
          normalize_input: expect.any(Number),
          load_sources: expect.any(Number),
          normalize_conversation: expect.any(Number),
          resolve: expect.any(Number),
          compile_prompt: expect.any(Number),
          build_tools: expect.any(Number),
        }),
        prompt: expect.objectContaining({
          orderHash: 'order-hash',
          totalChars: 6,
          estimatedTokens: 2,
        }),
        tools: { available: 3, active: 1 },
      }),
    );
  });

  it('emits completed phase timings and rethrows when preparation fails', async () => {
    const harness = createHarness();
    harness.dataLoader.load.mockRejectedValueOnce(new Error('memory unavailable'));

    await expect(harness.service.prepare(params, 'invoke')).rejects.toThrow('memory unavailable');
    expect(harness.tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'turn_preparation',
        status: 'failure',
        error: 'memory unavailable',
        phaseDurationsMs: expect.objectContaining({
          normalize_input: expect.any(Number),
          load_sources: expect.any(Number),
        }),
      }),
    );
    expect(harness.context.compose).not.toHaveBeenCalled();
  });
});
