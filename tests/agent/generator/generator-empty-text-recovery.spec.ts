import { GeneratorAgent, isRecoveryConfirmationReply } from '@agent/generator/generator.agent';
import { createTurnLedger } from '@agent/generator/preparation/turn-ledger';
import { CallerKind } from '@/enums/agent.enum';
import { createForm, type BookingCollectionForm } from '@resolution/collection';

/**
 * 空响应处理链：零工具空响应先带工具重试一次，仍空才落到无工具恢复。
 *
 * trace batch_6aa215c8…_1789012454653（0910）：qwen 首步 0 输出 token 且零工具，旧链路直接
 * 进无工具恢复——恢复提示写"工具链已经执行完"，模型没有工具就编了 M Stand 岗位；replan
 * 同样首步为空，恢复只能留一句"我帮你查下"的空头承诺。生产 7 天 198 次恢复里 195 次是这种形态。
 */
describe('GeneratorAgent 空响应恢复', () => {
  const makeCtx = (over: Record<string, unknown> = {}) => ({
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
    ...over,
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

  const buildService = (
    generate: jest.Mock,
    options: { ctx?: Record<string, unknown>; collectionForms?: { peekActive: jest.Mock } } = {},
  ) => {
    const llm = { supportsVisionInput: jest.fn().mockResolvedValue(false), generate };
    const preparation = { prepare: jest.fn().mockResolvedValue(makeCtx(options.ctx)) };
    const configService = { get: (_key: string, defaultValue?: string) => defaultValue };
    return new GeneratorAgent(
      configService as never,
      preparation as never,
      {} as never,
      llm as never,
      options.collectionForms as never,
    );
  };

  const invoke = (service: GeneratorAgent, text = '我想找咖啡店兼职呢') =>
    service.invoke({
      callerKind: CallerKind.WECOM,
      messages: [{ role: 'user', content: text }],
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
    // trace batch_6accb41bce406a6aee72e009_1791805375446：恢复补出"我这就帮你提交报名，约的是周三 14 号下午 2 点"
    expect(recovery.prompt).toContain('禁止写“这就帮你提交/马上帮你报名/已经约好');
    expect(recovery.prompt).toContain(
      '只有 duliday_interview_booking success=true 才能声称新预约已成功',
    );

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

  it.each([
    [
      'duliday_interview_precheck',
      { requestedDate: { status: 'unavailable' }, nearestBookableSlot: '2026-10-22 14:00:00' },
    ],
    ['duliday_modify_interview_time', { success: true, interviewTime: '2026-10-22 14:00:00' }],
    [
      'duliday_interview_precheck',
      {
        success: true,
        nextAction: 'already_booked',
        duplicateBookingGuard: { interviewTime: '2026-10-22 14:00:00' },
      },
    ],
  ])('空文本恢复保留 %s 的时间事实且不要求新 booking', async (toolName, output) => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: '',
        steps: [
          {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [{ toolCallId: 'grounded', toolName, input: {} }],
            toolResults: [{ toolCallId: 'grounded', output }],
          },
        ],
        usage,
        response: { messages: [] },
      })
      .mockResolvedValueOnce({ text: '已根据工具核实时间', usage, response: { messages: [] } });
    const result = await invoke(buildService(generate));
    const recovery = generate.mock.calls[1][0];
    expect(recovery.tools).toBeUndefined();
    expect(recovery.prompt).toContain('2026-10-22 14:00:00');
    expect(recovery.prompt).toContain('必须区分“可选择”和“已预约”');
    expect(recovery.prompt).toContain('可以确认改期结果');
    expect(recovery.prompt).toContain('可以复述已有预约');
    expect(recovery.prompt).not.toContain('不得告诉候选人任何面试时间');
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

/**
 * 待提交节点的确定性闸（BadCase 复核 [07]，trace batch_6accb41bce406a6aee72e009_1791805375446）：
 * 上一轮 precheck 返回 confirm_collection，候选人"没问题的"，qwen 生成 / 带工具重试均 0 输出 token，
 * 无工具恢复补出"我这就帮你提交报名，约的是周三 14 号下午 2 点"——候选人 10-14 真去了门店。
 * 这个节点上任何补出来的文本都是空头承诺：不补，交 Runner 转人工。
 */
describe('GeneratorAgent 空响应恢复 · 待提交确认节点转人工', () => {
  const CONTRACT = [
    {
      labelId: 101,
      labelTitle: '姓名',
      fieldType: 'TEXT' as const,
      required: true,
      acceptedOptions: [],
      rejectedOptions: [],
      systemField: 'name' as const,
    },
  ];
  const emptyUsage = { inputTokens: 100, outputTokens: 0, totalTokens: 100 };
  const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
  const emptyStep = () => ({
    text: '',
    reasoningText: undefined,
    steps: [{ text: '', finishReason: 'stop', usage: emptyUsage }],
    usage: emptyUsage,
    response: { messages: [] },
  });
  const recoveredText = () => ({
    text: '好的，我这就帮你提交报名，约的是周三下午 2 点',
    reasoningText: undefined,
    usage,
    response: { messages: [] },
  });

  /** 外部预填（需 recap）且复述已发出、尚未确认 → precheck 停在 confirm_collection。 */
  const awaitingRecapForm = (): BookingCollectionForm => {
    const form = createForm({ jobId: 100, contract: CONTRACT });
    form.slots[101] = {
      labelId: 101,
      state: 'filled',
      value: { value: '兮兮', producer: 'archive' },
    } as never;
    form.lastRecap = { labelIds: [101] };
    return form;
  };
  /** 资料已授权且已选时段 → precheck 停在 ready_to_book。 */
  const readyToBookForm = (): BookingCollectionForm => {
    const form = createForm({ jobId: 100, contract: CONTRACT });
    form.slots[101] = {
      labelId: 101,
      state: 'filled',
      value: { value: '兮兮', producer: 'candidate_quote' },
    } as never;
    form.scheduleDraft = {
      requestedDate: '2026-10-14',
      selectedInterviewTime: '2026-10-14 14:00:00',
      sourceText: '周三下午两点',
    };
    return form;
  };

  const ctxFor = (userText: string) => ({
    botUserId: 'wecom-user-A',
    normalizedMessages: [
      {
        role: 'assistant',
        content: '帮你核对一下报名信息（服务员）：\n姓名：兮兮\n没问题的话我这就帮你提交',
      },
      { role: 'user', content: `${userText}\n[消息发送时间：2026-10-12 19:42:10]` },
    ],
    memorySnapshot: { currentFocusJob: { jobId: 100, availableDetailFields: [] } },
  });

  const makeService = (
    generate: jest.Mock,
    userText: string,
    form: BookingCollectionForm | null,
  ) => {
    const collectionForms = { peekActive: jest.fn().mockResolvedValue(form) };
    const llm = { supportsVisionInput: jest.fn().mockResolvedValue(false), generate };
    const preparation = {
      prepare: jest.fn().mockResolvedValue({
        corpId: 'c1',
        userId: 'u1',
        sessionId: 's1',
        botImId: undefined,
        contactName: undefined,
        finalPrompt: 'system prompt',
        tools: { duliday_interview_precheck: {} },
        maxSteps: 3,
        memoryLoadWarning: undefined,
        entryStage: undefined,
        ledger: createTurnLedger(),
        toolExecutionTimings: new Map<string, number>(),
        ...ctxFor(userText),
      }),
    };
    const configService = { get: (_key: string, defaultValue?: string) => defaultValue };
    const service = new GeneratorAgent(
      configService as never,
      preparation as never,
      {} as never,
      llm as never,
      collectionForms as never,
    );
    return { service, collectionForms };
  };

  const invoke = (service: GeneratorAgent, text: string) =>
    service.invoke({
      callerKind: CallerKind.WECOM,
      messages: [{ role: 'user', content: text }],
      userId: 'u1',
      corpId: 'c1',
      sessionId: 's1',
    });

  it('上一轮 confirm_collection + 本轮"没问题的" + 两次零产出 → 不进无工具恢复，留空正文并标记转人工', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce(recoveredText());
    const { service, collectionForms } = makeService(generate, '没问题的', awaitingRecapForm());

    const result = await invoke(service, '没问题的');

    // 生成 + 带工具重试两次，第三次（无工具恢复）不再发生
    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].purpose).toBe('empty_text_retry');
    expect(result.text).toBe('');
    expect(result.recoveryDisposition).toEqual(
      expect.objectContaining({
        outcome: 'handoff',
        reasonCode: 'empty_recovery_pending_submission',
        precheckNextAction: 'confirm_collection',
        jobId: 100,
      }),
    );
    expect(result.recoveryDisposition?.reason).toContain('没问题的');
    expect(collectionForms.peekActive).toHaveBeenCalledWith({
      corpId: 'c1',
      userId: 'u1',
      botUserId: 'wecom-user-A',
      jobId: 100,
    });
  });

  it('上一轮 ready_to_book（已授权且已选时段）+ 本轮"好的" → 同样转人工', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce(recoveredText());
    const { service } = makeService(generate, '好的', readyToBookForm());

    const result = await invoke(service, '好的');

    expect(generate).toHaveBeenCalledTimes(2);
    expect(result.text).toBe('');
    expect(result.recoveryDisposition?.precheckNextAction).toBe('ready_to_book');
  });

  it.each(['confirm_collection', 'ready_to_book'])(
    '活动追加候选人 %s 双空响应也必须转人工',
    async (state) => {
      const generate = jest
        .fn()
        .mockResolvedValueOnce(emptyStep())
        .mockResolvedValueOnce(emptyStep());
      const form = state === 'confirm_collection' ? awaitingRecapForm() : readyToBookForm();
      const { service } = makeService(generate, '好的', { ...form, candidateScope: 'additional' });
      const result = await invoke(service, '好的');
      expect(generate).toHaveBeenCalledTimes(2);
      expect(result.recoveryDisposition?.precheckNextAction).toBe(state);
    },
  );

  it('本轮 precheck 回执已停在 confirm_collection 时不读表单，直接按本轮回执判定', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        text: '',
        reasoningText: undefined,
        steps: [
          {
            text: '',
            finishReason: 'tool-calls',
            toolCalls: [
              {
                toolCallId: 't1',
                toolName: 'duliday_interview_precheck',
                input: { mode: 'validate', jobId: 100, recapConfirmation: true },
              },
            ],
            toolResults: [
              {
                toolCallId: 't1',
                toolName: 'duliday_interview_precheck',
                output: { success: true, nextAction: 'confirm_collection' },
              },
            ],
          },
        ],
        usage,
        response: { messages: [] },
      })
      .mockResolvedValueOnce(recoveredText());
    const { service, collectionForms } = makeService(generate, '好的呀', null);

    const result = await invoke(service, '好的呀');

    // 工具已执行 → 不带工具重试；闸命中 → 也不进无工具恢复
    expect(generate).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('');
    expect(result.recoveryDisposition).toEqual(
      expect.objectContaining({ precheckNextAction: 'confirm_collection', jobId: 100 }),
    );
    expect(collectionForms.peekActive).not.toHaveBeenCalled();
  });

  it.each([
    ['success_after', true],
    ['failed_after', false],
    ['other_job_after', false],
    ['success_before', false],
    ['already_booked', true],
  ])('本轮预约终态 %s 决定是否恢复回执，而非误报未提交', async (kind, recover) => {
    const precheck = {
      toolCallId: 'precheck',
      toolName: 'duliday_interview_precheck',
      input: { mode: 'validate', jobId: 100, recapConfirmation: true },
      output: {
        success: true,
        nextAction: kind === 'already_booked' ? 'already_booked' : 'ready_to_book',
      },
    };
    const booking = {
      toolCallId: 'booking',
      toolName: 'duliday_interview_booking',
      input: { jobId: kind === 'other_job_after' ? 200 : 100 },
      output: { success: kind !== 'failed_after', workOrderId: 901 },
    };
    const calls =
      kind === 'already_booked'
        ? [precheck]
        : kind === 'success_before'
          ? [booking, precheck]
          : [precheck, booking];
    if (kind === 'success_after') {
      calls.unshift(
        ...Array.from({ length: 3 }, (_, index) => ({
          ...precheck,
          toolCallId: `long-${index}`,
          toolName: 'duliday_job_list',
          output: { ...precheck.output, padding: 'x'.repeat(10000) },
        })),
      );
    }
    const generate = jest
      .fn()
      .mockResolvedValueOnce({
        ...emptyStep(),
        steps: calls.map((call) => ({
          text: '',
          finishReason: 'tool-calls',
          toolCalls: [{ toolCallId: call.toolCallId, toolName: call.toolName, input: call.input }],
          toolResults: [
            { toolCallId: call.toolCallId, toolName: call.toolName, output: call.output },
          ],
        })),
      })
      .mockResolvedValueOnce({ ...recoveredText(), text: '面试预约已成功。' });
    const { service, collectionForms } = makeService(generate, '好的', awaitingRecapForm());
    const result = await invoke(service, '好的');
    expect(collectionForms.peekActive).not.toHaveBeenCalled();
    if (recover) {
      expect(result.recoveryDisposition).toBeUndefined();
      expect(result.text).toBe('面试预约已成功。');
      expect(generate).toHaveBeenCalledTimes(2);
      if (kind === 'success_after') {
        const prompt = generate.mock.calls[1][0].prompt as string;
        const receipt = prompt
          .split('本轮已完成的业务动作（真实成功回执，优先于前序待提交状态）：\n')[1]
          .split('\n\n对话上下文：')[0];
        expect(JSON.parse(JSON.parse(receipt)[0].result).workOrderId).toBe(901);
        expect(prompt).toContain('禁止再说“这就提交/稍等结果”');
      }
    } else {
      expect(result.recoveryDisposition?.reasonCode).toBe('empty_recovery_pending_submission');
      expect(generate).toHaveBeenCalledTimes(1);
    }
  });

  it('候选人不是确认词（在问别的时间）→ 闸不触发，照旧无工具恢复', async () => {
    const generate = jest
      .fn()
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce(emptyStep())
      .mockResolvedValueOnce({
        text: '周四也可以的，你看周四下午几点方便？',
        reasoningText: undefined,
        usage,
        response: { messages: [] },
      });
    const { service, collectionForms } = makeService(generate, '周四可以吗', awaitingRecapForm());

    const result = await invoke(service, '周四可以吗');

    expect(generate).toHaveBeenCalledTimes(3);
    expect(generate.mock.calls[2][0].purpose).toBe('empty_text_recovery');
    expect(result.text).toBe('周四也可以的，你看周四下午几点方便？');
    expect(result.recoveryDisposition).toBeUndefined();
    expect(collectionForms.peekActive).not.toHaveBeenCalled();
  });

  it('表单仍在收资（collecting）或读取失败 → 闸不触发', async () => {
    const collecting = createForm({ jobId: 100, contract: CONTRACT });
    for (const form of [collecting, null]) {
      const generate = jest
        .fn()
        .mockResolvedValueOnce(emptyStep())
        .mockResolvedValueOnce(emptyStep())
        .mockResolvedValueOnce({
          text: '好的，那你把姓名发我一下',
          reasoningText: undefined,
          usage,
          response: { messages: [] },
        });
      const { service, collectionForms } = makeService(generate, '好的', form);
      if (form === null) collectionForms.peekActive.mockRejectedValue(new Error('redis down'));

      const result = await invoke(service, '好的');

      expect(generate).toHaveBeenCalledTimes(3);
      expect(result.text).toBe('好的，那你把姓名发我一下');
      expect(result.recoveryDisposition).toBeUndefined();
    }
  });

  it.each([
    ['没问题的', true],
    ['好的呀', true],
    ['可以', true],
    ['行啦', true],
    ['嗯嗯\n[消息发送时间：2026-10-12 19:42:10]', true],
    ['周四可以吗', false],
    ['好的，周三下午两点我去不了', false],
    ['不行', false],
    ['', false],
  ])('isRecoveryConfirmationReply(%p) = %p', (text, expected) => {
    expect(isRecoveryConfirmationReply(text)).toBe(expected);
  });
});
