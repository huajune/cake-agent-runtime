import { GeneratorAgent } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';

/**
 * agent_steps 墙钟锚随 llm-executor 每次尝试重置：失败尝试同样触发 onStepFinish，
 * 锚不重置则其步末墙钟错配到成功尝试的 steps 上。durationMs 只计成功尝试的窗口。
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
          onAttemptStart?: (info: {
            modelId: string;
            attempt: number;
            resumedStepCount: number;
          }) => void;
          onStepFinish?: () => void;
        }) => {
          // 尝试 1：完成一步后失败（校验不过），留下孤儿步末墙钟
          options.onAttemptStart?.({
            modelId: 'qwen/qwen3.7-plus',
            attempt: 1,
            resumedStepCount: 0,
          });
          await delay(FAILED_ATTEMPT_MS);
          options.onStepFinish?.();
          // 尝试 2：成功
          options.onAttemptStart?.({
            modelId: 'qwen/qwen3.7-plus',
            attempt: 2,
            resumedStepCount: 0,
          });
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

  /**
   * 多步循环中途失败后 executor 续接已完成的工具步（不重放副作用）：这些步的墙钟原样保留，
   * agent_steps/tool_calls 逐条标注 attempt，流水能看出首次尝试里真实执行过的 booking。
   * （生产 batch …_1790057431146：attempt 1 booking 成功后 provider 超时，旧实现 attempt 2
   * 从 step 0 重放 booking 且流水只留 attempt 2 的记录。）
   */
  it('续接前次已完成步骤时保留其墙钟并标注 attempt', async () => {
    const TOOL_STEP_MS = 30;
    const FAILED_TAIL_MS = 200;
    const toolStep = {
      text: '',
      finishReason: 'tool-calls',
      toolCalls: [
        { toolCallId: 'call-1', toolName: 'duliday_interview_booking', input: { jobId: 1 } },
      ],
      toolResults: [
        {
          toolCallId: 'call-1',
          toolName: 'duliday_interview_booking',
          output: { success: true, workOrderId: 467600 },
        },
      ],
    };
    const finalStep = { text: '预约成功啦', finishReason: 'stop' };

    const llm = {
      supportsVisionInput: jest.fn().mockResolvedValue(false),
      generate: jest.fn(
        async (options: {
          onAttemptStart?: (info: {
            modelId: string;
            attempt: number;
            resumedStepCount: number;
          }) => void;
          onStepFinish?: () => void;
        }) => {
          // 尝试 1：工具步完成后 provider 超时
          options.onAttemptStart?.({
            modelId: 'qwen/qwen3.7-plus',
            attempt: 1,
            resumedStepCount: 0,
          });
          await delay(TOOL_STEP_MS);
          options.onStepFinish?.();
          await delay(FAILED_TAIL_MS);
          // 尝试 2：续接 1 步，只重生成末步
          options.onAttemptStart?.({
            modelId: 'qwen/qwen3.7-plus',
            attempt: 2,
            resumedStepCount: 1,
          });
          await delay(TOOL_STEP_MS);
          options.onStepFinish?.();
          return {
            text: '预约成功啦',
            reasoningText: undefined,
            steps: [toolStep, finalStep],
            stepAttempts: [1, 2],
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
      messages: [{ role: 'user', content: '帮我报名' }],
      userId: 'u1',
      corpId: 'c1',
      sessionId: 's1',
    });

    expect(result.agentSteps).toHaveLength(2);
    expect(result.agentSteps[0].attempt).toBe(1);
    expect(result.agentSteps[1].attempt).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]).toMatchObject({
      toolName: 'duliday_interview_booking',
      attempt: 1,
      status: 'ok',
    });
    // 续接步的墙钟不被尝试 2 重置：步 0 只计工具步窗口（~30ms）
    expect(result.agentSteps[0].durationMs).toBeLessThan(FAILED_TAIL_MS / 2);
    // 末步从步 0 结束算起，涵盖失败尝试的等待窗口
    expect(result.agentSteps[1].durationMs).toBeGreaterThanOrEqual(FAILED_TAIL_MS);
  });

  it('全部步骤来自同一次尝试时不标注 attempt', async () => {
    const llm = {
      supportsVisionInput: jest.fn().mockResolvedValue(false),
      generate: jest.fn(async () => ({
        text: '你好',
        reasoningText: undefined,
        steps: [{ text: '你好', finishReason: 'stop' }],
        stepAttempts: [1],
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        response: { messages: [] },
        modelId: 'qwen/qwen3.7-plus',
      })),
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

    expect(result.agentSteps[0].attempt).toBeUndefined();
  });
});
