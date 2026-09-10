import { GeneratorAgent } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';

/**
 * 模型偶发不走 tool-call 通道，把工具往返演在文本里（thinking 模式下落在 reasoning，
 * 正文只留一句想当然的回执或一串编造的岗位）。零工具调用 = 无既成副作用，故带工具重跑一次是安全的。
 */
describe('GeneratorAgent 工具调用文本化重生成', () => {
  const LEAKED_REASONING = `{
  "tool_name": "duliday_interview_booking",
  "arguments": { "jobId": 529147, "interviewTime": "2026-09-02 13:30:00" }
}`;
  /** chat 6aa0cf1e 09-09：reasoning 里一整份假查岗回执，零工具，正文编了 5 家门店。 */
  const FAKE_RESULT_REASONING = `{
  "jobList": [
    { "jobId": 432206, "jobName": "瑞幸咖啡-佛山北滘公园店-店员-小时工", "distanceKm": 0.8, "salary": "20元/小时" },
    { "jobId": 431895, "jobName": "奈雪的茶-佛山北滘店-店员-小时工", "distanceKm": 0.9, "salary": "19-22元/小时" }
  ]
}`;
  /** chat 6a97b336 09-07：reasoning 里 XML 形态的假 precheck 调用，零工具，正文宣称报名已提交。 */
  const XML_CALL_REASONING = `<function_calls>
<invoke name="duliday_interview_precheck">
<parameter name="mode">validate</parameter>
<parameter name="jobId">528334</parameter>
</invoke>
</function_calls>`;

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

  it.each([
    [
      '假回执 JSON（同构记录表）',
      FAKE_RESULT_REASONING,
      '帮你查了下，北滘公园附近有几家在招\n\n瑞幸咖啡（佛山北滘公园店），离你0.8公里，20元/时',
    ],
    ['XML 形态假调用', XML_CALL_REASONING, '周建青的报名也提交成功了'],
  ])('零工具调用 + reasoning 含%s → 同样带工具重生成', async (_label, reasoning, firstText) => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: firstText,
        reasoningText: reasoning,
        steps: [{ text: firstText, reasoningText: reasoning, finishReason: 'stop' }],
        usage,
        response: { messages: [] },
      })
      .mockResolvedValueOnce({
        text: '我帮你查下附近的岗位',
        reasoningText: undefined,
        steps: [
          {
            text: '我帮你查下附近的岗位',
            finishReason: 'stop',
            toolCalls: [{ toolCallId: 't1', toolName: 'duliday_job_list', input: {} }],
            toolResults: [{ toolCallId: 't1', output: { items: [] } }],
          },
        ],
        usage,
        response: { messages: [] },
      });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].instructions).toContain('模拟了工具的调用或返回结果');
    expect(generate.mock.calls[1][0].tools).toBeDefined();
    expect(result.text).toBe('我帮你查下附近的岗位');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.agentSteps).toHaveLength(2);
  });

  it('reasoning 里的单键对象数组（候选人贴的表单结构）不触发重试', async () => {
    const generate = jest.fn().mockResolvedValue({
      text: '收到，社会身份和年龄都记下了',
      reasoningText:
        '候选人回了表单：[{"properties":{"labelTitle":"社会身份","value":"社会人士"}},{"properties":{"labelTitle":"年龄","value":"26"}}]',
      steps: [{ text: '收到，社会身份和年龄都记下了', finishReason: 'stop' }],
      usage,
      response: { messages: [] },
    });

    const result = await invoke(buildService(generate));

    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('收到，社会身份和年龄都记下了');
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
