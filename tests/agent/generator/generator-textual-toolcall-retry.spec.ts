import { GeneratorAgent } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';

/**
 * 模型偶发不走 tool-call 通道，把调用写成 JSON 文本（thinking 模式下落在 reasoning，
 * 正文只留一句想当然的回执）。零工具调用 = 无既成副作用，故带工具重跑一次是安全的。
 */
describe('GeneratorAgent 工具调用文本化重生成', () => {
  const LEAKED_REASONING = `{
  "tool_name": "duliday_interview_booking",
  "arguments": { "jobId": 529147, "interviewTime": "2026-09-02 13:30:00" }
}`;

  const makeCtx = () => ({
    corpId: 'c1',
    userId: 'u1',
    sessionId: 's1',
    botUserId: undefined,
    botImId: undefined,
    contactName: undefined,
    normalizedMessages: [{ role: 'user', content: '周三下午一点半' }],
    finalPrompt: 'system prompt',
    tools: {},
    maxSteps: 3,
    memorySnapshot: undefined,
    memoryLoadWarning: undefined,
    entryStage: undefined,
    ledger: createTurnLedger(),
    toolExecutionTimings: new Map<string, number>(),
  });

  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

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
      messages: [{ role: 'user', content: '周三下午一点半' }],
      userId: 'u1',
      corpId: 'c1',
      sessionId: 's1',
    });

  it('零工具调用 + reasoning 含调用 blob → 带工具重生成，取重试产物', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: '预约成功',
        reasoningText: LEAKED_REASONING,
        steps: [{ text: '预约成功', reasoningText: LEAKED_REASONING, finishReason: 'stop' }],
        usage,
        response: { messages: [] },
      })
      .mockResolvedValueOnce({
        text: '已帮你约好 9月2日（周三）13:30',
        reasoningText: undefined,
        steps: [
          {
            text: '已帮你约好 9月2日（周三）13:30',
            finishReason: 'stop',
            toolCalls: [{ toolCallId: 't1', toolName: 'duliday_interview_booking', input: {} }],
            toolResults: [{ toolCallId: 't1', output: { success: true, workOrderId: 9527 } }],
          },
        ],
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(2);
    // 重试的 system prompt 末尾追加纠正指令，首版不带
    expect(generate.mock.calls[0][0].instructions).toBe('system prompt');
    expect(generate.mock.calls[1][0].instructions).toContain('tool call 通道');
    // 重试仍带工具：修复点就在于让这次真的能调用
    expect(generate.mock.calls[1][0].tools).toBeDefined();

    expect(result.text).toBe('已帮你约好 9月2日（周三）13:30');
    expect(result.toolCalls).toHaveLength(1);
    // 首版 steps 前置保留，泄漏在流水里可见；usage 两次相加
    expect(result.agentSteps).toHaveLength(2);
    expect(result.agentSteps[0].reasoning).toContain('duliday_interview_booking');
    expect(result.agentSteps.map((s) => s.stepIndex)).toEqual([0, 1]);
    expect(result.usage.totalTokens).toBe(30);
  });

  it('本轮已有工具调用时不重试——已有副作用，重跑会重复提交', async () => {
    const generate = jest.fn().mockResolvedValue({
      text: '帮你查到了',
      reasoningText: LEAKED_REASONING,
      steps: [
        {
          text: '帮你查到了',
          reasoningText: LEAKED_REASONING,
          finishReason: 'stop',
          toolCalls: [{ toolCallId: 't1', toolName: 'duliday_job_list', input: {} }],
          toolResults: [{ toolCallId: 't1', output: { items: [{ jobId: 1 }] } }],
        },
      ],
      usage,
      response: { messages: [] },
    });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('帮你查到了');
  });

  it('无 blob 的正常零工具回合不重试', async () => {
    const generate = jest.fn().mockResolvedValue({
      text: '你平时在哪个区域呀？',
      reasoningText: '候选人还没给地址，先问区域。',
      steps: [{ text: '你平时在哪个区域呀？', finishReason: 'stop' }],
      usage,
      response: { messages: [] },
    });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('你平时在哪个区域呀？');
  });

  it('重生成抛错时保留首版结果', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: '预约成功',
        reasoningText: LEAKED_REASONING,
        steps: [{ text: '预约成功', reasoningText: LEAKED_REASONING, finishReason: 'stop' }],
        usage,
        response: { messages: [] },
      })
      .mockRejectedValueOnce(new Error('provider 抖动'));

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('预约成功');
    expect(result.agentSteps).toHaveLength(1);
  });
});
