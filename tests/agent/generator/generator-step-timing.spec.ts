import { GeneratorAgent } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';

/**
 * agent_steps 墙钟锚与 llm-executor 重试的对齐契约（2026-08-31 慢回合事故）：
 *
 * 失败尝试（结果校验不过/多步中途断）也会触发 onStepFinish；若锚不随 onAttemptStart
 * 重置，首个失败尝试的步末墙钟会错配到最终成功尝试的 steps 上——生产曾出现
 * ai_duration 207s 而 agent_steps 只记 31s，重试整段隐形。本 spec 钉住：
 * agent_steps 的 durationMs 只计最后一次（成功）尝试的窗口。
 */
describe('GeneratorAgent step timing across executor retries', () => {
  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const makeCtx = () => ({
    corpId: 'c1',
    userId: 'u1',
    sessionId: 's1',
    botUserId: undefined,
    botImId: undefined,
    contactName: undefined,
    normalizedMessages: [{ role: 'user', content: '你好' }],
    finalPrompt: 'system prompt',
    tools: {},
    maxSteps: 3,
    memorySnapshot: undefined,
    memoryLoadWarning: undefined,
    entryStage: undefined,
    ledger: createTurnLedger(),
    toolExecutionTimings: new Map<string, number>(),
  });

  it('resets the step wallclock anchor on each executor attempt', async () => {
    const FAILED_ATTEMPT_MS = 400;
    const SUCCESS_ATTEMPT_MS = 30;

    const llm = {
      supportsVisionInput: jest.fn().mockResolvedValue(false),
      generate: jest.fn(
        async (options: {
          onAttemptStart?: (info: { modelId: string; attempt: number }) => void;
          onStepFinish?: () => void;
        }) => {
          // 尝试 1：完成一步后失败（校验不过），留下孤儿步末墙钟
          options.onAttemptStart?.({ modelId: 'qwen/qwen3.7-plus', attempt: 1 });
          await delay(FAILED_ATTEMPT_MS);
          options.onStepFinish?.();
          // 尝试 2：成功
          options.onAttemptStart?.({ modelId: 'qwen/qwen3.7-plus', attempt: 2 });
          await delay(SUCCESS_ATTEMPT_MS);
          options.onStepFinish?.();
          return {
            text: '最终回复',
            reasoningText: undefined,
            steps: [{ text: '最终回复', finishReason: 'stop' }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            response: { messages: [] },
            modelId: 'qwen/qwen3.7-plus',
          };
        },
      ),
    };
    const preparation = { prepare: jest.fn().mockResolvedValue(makeCtx()) };
    const configService = { get: (_key: string, defaultValue?: string) => defaultValue };
    const service = new GeneratorAgent(
      configService as never,
      preparation as never,
      {} as never,
      llm as never,
    );

    const result = await service.invoke({
      callerKind: CallerKind.WECOM,
      messages: [{ role: 'user', content: '你好' }],
      userId: 'u1',
      corpId: 'c1',
      sessionId: 's1',
    });

    expect(result.agentSteps).toHaveLength(1);
    const stepDuration = result.agentSteps[0].durationMs;
    expect(stepDuration).toBeDefined();
    // 锚重置后步长只计成功尝试窗口（~30ms），不含失败尝试的 400ms；
    // 未重置时会取到失败尝试的孤儿墙钟，量级在 400ms 以上。
    expect(stepDuration!).toBeLessThan(FAILED_ATTEMPT_MS / 2);
  });
});
