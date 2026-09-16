import { GeneratorAgent } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';

/**
 * 空响应处理链：零工具空响应先带工具重试一次，仍空才落到无工具恢复。
 *
 * trace batch_6aa215c8…_1789012454653（0910）：qwen 首步 0 输出 token 且零工具，旧链路直接
 * 进无工具恢复——恢复提示写"工具链已经执行完"，模型没有工具就编了 M Stand 岗位；replan
 * 同样首步为空，恢复只能留一句"我帮你查下"的空头承诺。生产 7 天 198 次恢复里 195 次是这种形态。
 */
describe('GeneratorAgent 空响应恢复', () => {
  const makeCtx = () => ({
    corpId: 'c1',
    userId: 'u1',
    sessionId: 's1',
    botUserId: undefined,
    botImId: undefined,
    contactName: undefined,
    normalizedMessages: [{ role: 'user', content: '我想找咖啡店兼职呢' }],
    finalPrompt: 'system prompt',
    tools: { duliday_job_list: {} },
    maxSteps: 3,
    memorySnapshot: undefined,
    memoryLoadWarning: undefined,
    entryStage: undefined,
    ledger: createTurnLedger(),
    toolExecutionTimings: new Map<string, number>(),
  });

  const emptyUsage = { inputTokens: 100, outputTokens: 0, totalTokens: 100 };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

  /** 首步空响应：无文本、无工具、0 输出 token（生产实测形态）。 */
  const emptyFirstStep = () => ({
    text: '',
    reasoningText: undefined,
    steps: [{ text: '', finishReason: 'stop', usage: emptyUsage }],
    usage: emptyUsage,
    response: { messages: [] },
  });

  const buildService = (generate: jest.Mock) => {
    const llm = { supportsVisionInput: jest.fn().mockResolvedValue(false), generate };
    const preparation = { prepare: jest.fn().mockResolvedValue(makeCtx()) };
    const configService = { get: (_key: string, defaultValue?: string) => defaultValue };
    return new GeneratorAgent(
      configService as never,
      preparation as never,
      {} as never,
      llm as never,
    );
  };

  const invoke = (service: GeneratorAgent) =>
    service.invoke({
      callerKind: CallerKind.WECOM,
      messages: [{ role: 'user', content: '我想找咖啡店兼职呢' }],
      userId: 'u1',
      corpId: 'c1',
      sessionId: 's1',
    });

  it('零工具空响应 → 带工具重试一次，重试真实查岗后定稿，不再进无工具恢复', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyFirstStep())
      .mockResolvedValueOnce({
        text: '七宝附近的 M Stand 在招咖啡师，离你 1.5km',
        reasoningText: undefined,
        steps: [
          {
            text: '七宝附近的 M Stand 在招咖啡师，离你 1.5km',
            finishReason: 'stop',
            toolCalls: [{ toolCallId: 't1', toolName: 'duliday_job_list', input: {} }],
            toolResults: [{ toolCallId: 't1', output: { items: [{ jobId: 1 }] } }],
          },
        ],
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[0][0].purpose).toBe('generation');
    // 重试带工具、带空响应纠正指令；首版 prompt 不带
    expect(generate.mock.calls[0][0].instructions).toBe('system prompt');
    expect(generate.mock.calls[1][0].instructions).toContain('没有产出任何内容');
    expect(generate.mock.calls[1][0].tools).toBeDefined();
    expect(generate.mock.calls[1][0].purpose).toBe('empty_text_retry');

    expect(result.text).toBe('七宝附近的 M Stand 在招咖啡师，离你 1.5km');
    expect(result.toolCalls).toHaveLength(1);
    // 首版空步前置保留，流水里能看到"首步 0 输出 token"；usage 两轮相加
    expect(result.agentSteps).toHaveLength(2);
    expect(result.agentSteps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(result.agentSteps[0].usage?.outputTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(115);
  });

  it('零工具空响应重试仍空 → 落到无工具恢复，恢复提示如实声明本轮没跑工具', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyFirstStep())
      .mockResolvedValueOnce(emptyFirstStep())
      .mockResolvedValueOnce({
        text: '想找咖啡店兼职是吧，你平时哪些时间段方便上班呀？',
        reasoningText: undefined,
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(3);
    const recovery = generate.mock.calls[2][0];
    expect(recovery.purpose).toBe('empty_text_recovery');
    expect(recovery.tools).toBeUndefined();
    expect(recovery.prompt).toContain('没有调用任何工具');
    expect(recovery.prompt).toContain('不得报出任何岗位名称');
    expect(recovery.prompt).not.toContain('工具链已经执行完');

    expect(result.text).toBe('想找咖啡店兼职是吧，你平时哪些时间段方便上班呀？');
    expect(result.agentSteps).toHaveLength(3);
    expect(result.agentSteps[2].finishReason).toBe('empty-text-recovery');
    expect(result.agentSteps.map((s) => s.stepIndex)).toEqual([0, 1, 2]);
  });

  it('工具已执行但没写终文本 → 不带工具重试（副作用不可重放），直接无工具恢复', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: '',
        reasoningText: undefined,
        steps: [
          {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [{ toolCallId: 't1', toolName: 'duliday_interview_booking', input: {} }],
            toolResults: [{ toolCallId: 't1', output: { success: true, workOrderId: 9527 } }],
          },
        ],
        usage,
        response: { messages: [] },
      })
      .mockResolvedValueOnce({
        text: '已经帮你约好了，面试时间到时候留意群消息',
        reasoningText: undefined,
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(2);
    const recovery = generate.mock.calls[1][0];
    expect(recovery.purpose).toBe('empty_text_recovery');
    expect(recovery.tools).toBeUndefined();
    expect(recovery.prompt).toContain('工具链已经执行完');
    expect(recovery.prompt).not.toContain('没有调用任何工具');
    expect(result.text).toBe('已经帮你约好了，面试时间到时候留意群消息');
    expect(result.toolCalls).toHaveLength(1);
  });

  it('带工具重试抛错 → 保留首版空结果继续走无工具恢复', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyFirstStep())
      .mockRejectedValueOnce(new Error('provider 抖动'))
      .mockResolvedValueOnce({
        text: '你平时主要在哪个区域呀？',
        reasoningText: undefined,
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(3);
    expect(result.text).toBe('你平时主要在哪个区域呀？');
    expect(result.agentSteps).toHaveLength(2);
  });
});
