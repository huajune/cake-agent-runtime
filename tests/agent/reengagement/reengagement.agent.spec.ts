import { ReengagementAgent } from '@agent/reengagement/reengagement.agent';
import { getScenario } from '@agent/reengagement/scenario-registry';
import type { FollowUpJob } from '@agent/reengagement/follow-up-scheduler.service';
import type { ReengagementSessionState } from '@memory/types/reengagement-session-state.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<ReengagementSessionState> = {}): ReengagementSessionState => ({
  collectedFields: {},
  recalledJobIds: new Set<number>(),
  hardConstraints: [],
  presentedStores: [],
  stage: null,
  ...over,
});

const job = (scenarioCode: FollowUpJob['scenarioCode'], over: Partial<FollowUpJob> = {}) =>
  ({
    sessionRef,
    scenarioCode,
    anchorEventId: 'evt-1',
    anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    ...over,
  }) as FollowUpJob;

const liveBookingContext = (over: Record<string, unknown> = {}) => ({
  workOrderId: 555,
  interviewAt: Date.UTC(2026, 5, 25, 6, 0, 0),
  interviewType: 'AI面试',
  currentStatus: '约面成功',
  ...over,
});

describe('ReengagementAgent', () => {
  let llm: { generateStructured: jest.Mock };
  let memory: { recallForProactiveFollowUp: jest.Mock };
  let reengagementAgent: ReengagementAgent;
  let memoryRecall: {
    recentMessages: Array<{ role: string; content: string }>;
    factLines: string[];
  };

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 0, 0));
    llm = {
      generateStructured: jest.fn().mockResolvedValue({
        output: {
          decision: 'send',
          blockReason: 'none',
          message: '你方便发下位置吗？我这边好按附近方向给你看。',
          reason: 'address_missing task has enough context',
        },
        usage: { inputTokens: 8, outputTokens: 6, totalTokens: 14 },
        response: { messages: [{ role: 'assistant', content: 'ok' }] },
      }),
    };
    // recallForProactiveFollowUp 直接复用 Generator 的消息窗口和时间后缀；facts 已渲染成字段行。
    memoryRecall = {
      recentMessages: [
        {
          role: 'user',
          content: '我在静安\n[消息发送时间：2026-06-24 09:55 星期三]',
        },
        {
          role: 'assistant',
          content: '你在哪个地铁站附近呀？\n[消息发送时间：2026-06-24 09:56 星期三]',
        },
      ],
      factLines: ['- 意向城市: 上海（置信度: high，来源: llm）'],
    };
    memory = {
      recallForProactiveFollowUp: jest.fn().mockResolvedValue(memoryRecall),
    };
    reengagementAgent = new ReengagementAgent(
      llm as never,
      memory as never,
      {
        get: () => undefined,
      } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('routes to the dedicated reengagement model when AGENT_REENGAGEMENT_MODEL is set', async () => {
    const agent = new ReengagementAgent(
      llm as never,
      memory as never,
      {
        get: (key: string) =>
          key === 'AGENT_REENGAGEMENT_MODEL' ? 'deepseek/deepseek-v4-pro' : undefined,
      } as never,
    );

    await agent.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
    });

    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'deepseek/deepseek-v4-pro' }),
    );
    // 缺省时不得携带 modelId，保持 Chat 角色路由（含 Dashboard 运行时覆盖）不变。
    llm.generateStructured.mockClear();
    await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
    });
    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.not.objectContaining({ modelId: expect.anything() }),
    );
  });

  it('prefers the dashboard runtime override over the env model', async () => {
    const agent = new ReengagementAgent(
      llm as never,
      memory as never,
      {
        get: (key: string) =>
          key === 'AGENT_REENGAGEMENT_MODEL' ? 'qwen/qwen3.7-plus' : undefined,
      } as never,
      { getRoleModelOverride: jest.fn().mockResolvedValue('deepseek/deepseek-v4-pro') },
    );

    await agent.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
    });

    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'deepseek/deepseek-v4-pro' }),
    );
  });

  it('falls back to the env model when the dashboard override read fails', async () => {
    const agent = new ReengagementAgent(
      llm as never,
      memory as never,
      {
        get: (key: string) =>
          key === 'AGENT_REENGAGEMENT_MODEL' ? 'qwen/qwen3.7-plus' : undefined,
      } as never,
      { getRoleModelOverride: jest.fn().mockRejectedValue(new Error('config store down')) },
    );

    await agent.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
    });

    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({ modelId: 'qwen/qwen3.7-plus' }),
    );
  });

  it('generates a structured message with assembled context for interview reminders', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '提醒你一下，面试是明天14:00，记得带身份证和健康证哈。',
        reason: 'interview reminder has interview evidence',
      },
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', {
        workOrderId: 555,
        expectedInterviewAt: Date.UTC(2026, 5, 25, 6, 0, 0),
        interviewType: 'AI面试',
      }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('本 Agent 不开放任何工具'),
        outputName: 'ReengagementMessage',
        messages: memoryRecall.recentMessages,
      }),
    );
    expect(llm.generateStructured.mock.calls[0][0].system).not.toContain(
      '任务代码：interview_reminder',
    );
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('# 已核验的最小上下文');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('当前时间：2026/6/24 10:00');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('今天：2026-06-24 星期三');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('明天：2026-06-25 星期四');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('后天：2026-06-26 星期五');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain(
      '面试日期相对当前：明天（只能说“明天”，不得说“今天”）',
    );
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('- 面试形式：AI面试');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('AI 面试说明无需到店');
    expect(llm.generateStructured.mock.calls[0][0]).not.toHaveProperty('tools');
    expect(llm.generateStructured.mock.calls[0][0]).not.toHaveProperty('stopWhen');
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.toolCalls).toEqual([]);
    expect(result.agentRequest).toMatchObject({
      reengagementOutput: expect.objectContaining({
        message: '提醒你一下，面试是明天14:00，记得带身份证和健康证哈。',
      }),
      reengagementInput: expect.objectContaining({
        trigger: expect.objectContaining({
          scenario: expect.objectContaining({ code: 'interview_reminder' }),
        }),
      }),
    });
    expect(result.agentRequest).not.toHaveProperty('outputGuardrail');
    expect(result.outcome.reply?.text).toContain('明天14:00');
    expect(result.outcome.reply?.text).toContain('身份证');
  });

  it('builds the d2 confirmation prompt with weekday and adjustment or abandonment exits', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '还在找工作吗？周四14:00约了面试，时间不合适可以提前跟我说调整。',
        reason: '报名后尚未另行确认求职意向',
      },
      usage: { inputTokens: 12, outputTokens: 9, totalTokens: 21 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', {
        workOrderId: 555,
        touchVariant: 'd2_confirm',
      }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext({
        interviewType: '线下面试',
        interviewAddress: '测试地址',
      }),
    });

    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('面试日期（含星期）：2026-06-25 星期四');
    expect(system).toContain('时间不合适可以提前调整');
    expect(system).toContain('已经找到合适工作可以告知放弃');
    expect(system).toContain('blockReason=confirmation_already_sent');
    expect(result.outcome.kind).toBe('reply');
  });

  it('does not treat an earlier d2 intent confirmation as an arrival reminder already sent', async () => {
    memoryRecall.recentMessages = [
      { role: 'assistant', content: '还在找工作吗？周四的面试时间可以吧？' },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '提醒一下，今天14:00记得按面试通知参加。',
        reason: '此前只有提前意向确认，没有到场提醒',
      },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', { workOrderId: 555 }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(llm.generateStructured.mock.calls[0][0].system).toContain(
      '面试前 1–3 天发出的求职意向确认消息不构成已提醒',
    );
    expect(result.outcome.kind).toBe('reply');
  });

  it('accepts confirmation_already_sent as a d2 semantic stop reason', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'skip',
        blockReason: 'confirmation_already_sent',
        message: '',
        reason: '招募经理已在报名后另行确认过本次面试意向',
      },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', { workOrderId: 555, touchVariant: 'd2_confirm' }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('confirmation_already_sent');
  });

  it('corrects “tomorrow” to “today” when an interview reminder fires on the interview date', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '提醒你一下，明天14:00参加面试。',
        reason: '面试提醒',
      },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', {
        expectedInterviewAt: Date.UTC(2026, 5, 24, 6, 0, 0),
      }),
      state: baseState({
        terminal: 'booked',
        interviewAt: Date.UTC(2026, 5, 24, 6, 0, 0),
      } as Partial<ReengagementSessionState>),
      bookingContext: liveBookingContext({ interviewAt: Date.UTC(2026, 5, 24, 6, 0, 0) }),
    });

    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('面试日期相对当前：今天（只能说“今天”，不得说“明天”）');
    expect(result.outcome.reply?.text).toBe('提醒你一下，今天14:00参加面试。');
    expect(result.agentRequest).toMatchObject({
      temporalCorrection: {
        originalMessage: '提醒你一下，明天14:00参加面试。',
        reason: 'interview_relative_day_mismatch',
      },
    });
  });

  it('corrects a reminder time that belongs to another work order', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '今天下午14点半的面试别忘了哈。',
        reason: '误用了近期对话中另一场面试的时间',
      },
      usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
    });

    const interviewAt = Date.UTC(2026, 6, 17, 5, 0, 0); // 13:00 Shanghai
    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', { workOrderId: 111 }),
      state: baseState({ terminal: 'booked', interviewAt } as Partial<ReengagementSessionState>),
      bookingContext: liveBookingContext({ workOrderId: 111, interviewAt }),
    });

    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('候选人可能同时有多个面试');
    expect(result.outcome.reply?.text).toBe('今天13:00的面试别忘了哈。');
    expect(result.agentRequest).toMatchObject({
      temporalCorrection: {
        originalMessage: '今天下午14点半的面试别忘了哈。',
        reason: 'interview_time_mismatch',
      },
    });
  });

  it.each(['interview_reminder', 'post_interview_followup'] as const)(
    'semantically skips %s when the latest candidate message says the interview was cancelled',
    async (scenarioCode) => {
      memoryRecall.recentMessages = [
        { role: 'assistant', content: '面试安排在星期一下午。' },
        { role: 'user', content: '不好意思哈，星期一约好的面试我去不了了。' },
      ];
      llm.generateStructured.mockResolvedValueOnce({
        output: {
          decision: 'skip',
          blockReason: 'candidate_declined_interview',
          message: '',
          reason: '候选人最新明确表示约好的面试去不了了',
        },
        usage: { inputTokens: 16, outputTokens: 6, totalTokens: 22 },
      });

      const result = await reengagementAgent.compose({
        sessionRef,
        scenario: getScenario(scenarioCode)!,
        jobData: job(scenarioCode, {
          expectedInterviewAt: Date.UTC(2026, 5, 24, 6, 0, 0),
        }),
        state: baseState({ terminal: 'booked' }),
        bookingContext: liveBookingContext(),
      });

      const call = llm.generateStructured.mock.calls[0][0];
      const system = call.system as string;
      expect(call.messages).toContainEqual({
        role: 'user',
        content: '不好意思哈，星期一约好的面试我去不了了。',
      });
      expect(system).toContain('即使实时工单仍显示预约有效也不能发送');
      // 抽样审计三类高频错误的 prompt 防线：证据先行的判定步骤、禁止模糊理由跳过、
      // 预约当轮/另行提醒的客观时间锚点（报名完成时间）。
      expect(system).toContain('判定步骤：先定位候选人');
      expect(system).toContain('不得以“对话流程正常”');
      expect(system).toContain('报名完成时间');
      if (scenarioCode === 'interview_reminder') {
        // 抽样审计：模型高频把预约当轮的收尾叮嘱/二维码交付误判为“已提醒”（误杀），
        // 也漏判预约回合后另行发出的口头提醒（漏拦）。口径必须给出正反例。
        expect(system).toContain('预约成功当轮的告知与收尾叮嘱都不算已提醒');
        expect(system).toContain('预约回合之后另行发出的提醒参加消息');
      }
      // 生产 badcase（touch 19712）：候选人说“干不了”且顾问已转拉群，提醒仍被发出。
      // 判据必须覆盖婉拒表达 + 转群语境，并区分“为本次面试拉群”不算放弃。
      expect(system).toContain('干不了');
      expect(system).toContain('邀请进群、改推其他岗位');
      expect(system).toContain('招募经理为本次面试拉群');
      // badcase chat 6a6093e3（2026-07-24）：经理"那不太合适"婉拒被以"未明确取消+
      // 工单仍有效"为由放行。婉拒口径必须成文，且禁止用这两条理由放行。
      expect(system).toContain('婉拒也算取消');
      expect(system).toContain('不得以"没有明确说取消"或"工单仍显示约面成功"为由放行发送');
      if (scenarioCode === 'post_interview_followup') {
        // badcase chat 6a607596（2026-07-24）：候选人已报告"已面试，等您通知"且经理已
        // 回应，回访仍问"面试结束了吧"。
        expect(system).toContain('interview_done_reported');
      }
      expect(result.outcome.kind).toBe('skipped');
      expect(result.outcome.reply).toBeUndefined();
      expect(result.validationReason).toBe('candidate_declined_interview');
      expect(result.agentRequest).toMatchObject({
        validationReason: 'candidate_declined_interview',
        reengagementOutput: {
          decision: 'skip',
          message: '',
        },
      });
    },
  );

  it.each([
    {
      name: 'the recruiter cancelled because the role was filled',
      scenarioCode: 'post_interview_followup' as const,
      messages: [{ role: 'assistant', content: '门店已经招满了，这次面试不用过去了。' }],
      blockReason: 'manager_cancelled_interview' as const,
    },
    {
      name: 'the conversation implies a failed interview result',
      scenarioCode: 'post_interview_followup' as const,
      messages: [{ role: 'user', content: '我刚才和店长吵起来了，店长让我走了。' }],
      blockReason: 'interview_result_known' as const,
    },
    {
      name: 'the recruiter already asked for the interview result',
      scenarioCode: 'interview_reminder' as const,
      messages: [{ role: 'assistant', content: '今天面试得怎么样，还顺利吗？' }],
      blockReason: 'result_inquiry_already_sent' as const,
    },
    {
      // badcase recvqgvKqRAcKg / chat 6a6093e3（2026-07-24）：经理婉拒"那不太合适"后
      // 未取消工单，提醒与回访仍照发。婉拒 + 候选人"行"接受即构成经理取消。
      name: 'the recruiter softly rejected the candidate without the word 取消',
      scenarioCode: 'interview_reminder' as const,
      messages: [
        { role: 'assistant', content: '有餐饮经验吗' },
        { role: 'user', content: '没有餐饮经验' },
        { role: 'assistant', content: '那不太合适' },
        { role: 'user', content: '行' },
      ],
      blockReason: 'manager_cancelled_interview' as const,
    },
    {
      // badcase recvqgxF51YhD8 / chat 6a607596（2026-07-24）：候选人已说"已面试，等您通知"
      // 且经理回应过"好"，7 小时后回访仍问"面试结束了吧？"。
      name: 'the candidate already reported the interview as done and awaiting notice',
      scenarioCode: 'post_interview_followup' as const,
      messages: [
        { role: 'user', content: '已面试，等您通知' },
        { role: 'assistant', content: '好' },
      ],
      blockReason: 'interview_done_reported' as const,
    },
    {
      name: 'the recruiter already sent an interview reminder',
      scenarioCode: 'interview_reminder' as const,
      messages: [{ role: 'assistant', content: '提醒一下，明天下午两点记得按时参加面试。' }],
      blockReason: 'interview_reminder_already_sent' as const,
    },
  ])(
    'blocks a post-booking message when $name',
    async ({ scenarioCode, messages, blockReason }) => {
      memoryRecall.recentMessages = messages;
      llm.generateStructured.mockResolvedValueOnce({
        output: {
          decision: 'send',
          blockReason,
          message: '这条消息不应该发送',
          reason: '近期对话命中停止条件',
        },
        usage: { inputTokens: 18, outputTokens: 6, totalTokens: 24 },
      });

      const result = await reengagementAgent.compose({
        sessionRef,
        scenario: getScenario(scenarioCode)!,
        jobData: job(scenarioCode, { workOrderId: 555 }),
        state: baseState({ terminal: 'booked' }),
        bookingContext: liveBookingContext(),
      });

      expect(result.outcome.kind).toBe('skipped');
      expect(result.outcome.reply).toBeUndefined();
      expect(result.validationReason).toBe(blockReason);
      expect(result.agentRequest).toMatchObject({ validationReason: blockReason });
    },
  );

  it('does not treat a previous reminder as a blocker for post-interview followup', async () => {
    memoryRecall.recentMessages = [
      { role: 'assistant', content: '提醒一下，明天下午两点记得按时参加面试。' },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '今天面试还顺利吗？',
        reason: '此前只有提醒，没有询问结果',
      },
      usage: { inputTokens: 16, outputTokens: 7, totalTokens: 23 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('post_interview_followup')!,
      jobData: job('post_interview_followup', { workOrderId: 555 }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe('今天面试还顺利吗？');
    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('此前只发送过面试提醒不构成停止条件');
  });

  it('documents that a rebook after cancellation follows the latest valid intent', async () => {
    memoryRecall.recentMessages = [
      { role: 'user', content: '明天的面试我去不了了。' },
      { role: 'assistant', content: '已经帮你改到周五下午两点。' },
      { role: 'user', content: '好的，周五下午两点我能参加。' },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '提醒一下，周五下午两点记得参加面试。',
        reason: '候选人最新确认了改约后的面试',
      },
      usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder', { workOrderId: 555 }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.validationReason).toBeUndefined();
  });

  it('retries a contradictory pre-booking skip and uses the corrected send decision', async () => {
    memoryRecall.recentMessages = [{ role: 'assistant', content: '你大概在哪个区域呀？' }];
    llm.generateStructured
      .mockResolvedValueOnce({
        output: {
          decision: 'skip',
          blockReason: 'none',
          message: '',
          reason: '当前处于正常对话流程',
        },
        usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
      })
      .mockResolvedValueOnce({
        output: {
          decision: 'send',
          blockReason: 'none',
          message: '还在看机会吗？你大概在哪个区或地铁站附近呀？',
          reason: '开场已发且候选人未回复',
        },
        usage: { inputTokens: 14, outputTokens: 8, totalTokens: 22 },
      });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toContain('还在看机会吗');
    expect(llm.generateStructured).toHaveBeenCalledTimes(2);
    expect(llm.generateStructured.mock.calls[1][0].system).toContain('上次输出纠正');
    expect(result.agentRequest).toMatchObject({
      outputCorrection: {
        issue: 'pre_booking_skip_not_allowed',
        firstOutput: expect.objectContaining({ decision: 'skip', blockReason: 'none' }),
        retryOutput: expect.objectContaining({ decision: 'send', blockReason: 'none' }),
      },
    });
  });

  it('safely skips and records a decision anomaly when correction is still inconsistent', async () => {
    memoryRecall.recentMessages = [{ role: 'user', content: '好的，知道了。' }];
    llm.generateStructured.mockResolvedValue({
      output: {
        decision: 'skip',
        blockReason: 'none',
        message: '',
        reason: '面试形式和时间存在冲突，当前证据不足',
      },
      usage: { inputTokens: 12, outputTokens: 5, totalTokens: 17 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('interview_reminder')!,
      jobData: job('interview_reminder'),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('reengagement_decision_invalid');
    expect(llm.generateStructured).toHaveBeenCalledTimes(2);
    expect(result.agentRequest).toMatchObject({
      validationReason: 'reengagement_decision_invalid',
      generationError: { name: 'ReengagementOutputContractError' },
      outputCorrection: { issue: 'skip_without_block_reason' },
    });
  });

  it('does not cap structured output and preserves request metadata without exposing errors as copy', async () => {
    llm.generateStructured.mockImplementationOnce(async (options) => {
      options.onPreparedRequest?.({
        modelId: 'qwen/qwen3.7-plus',
        fallbackModelIds: ['anthropic/claude-sonnet-4-6'],
      });
      throw new Error('No output generated.');
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('store_presented_no_reply')!,
      jobData: job('store_presented_no_reply'),
      state: baseState(),
    });

    const request = llm.generateStructured.mock.calls[0][0];
    expect(request).not.toHaveProperty('maxOutputTokens');
    expect(result.outcome.kind).toBe('skipped');
    expect(result.outcome.generatedText).toBeUndefined();
    expect(result.agentRequest).toMatchObject({
      modelId: 'qwen/qwen3.7-plus',
      fallbackModelIds: ['anthropic/claude-sonnet-4-6'],
      validationReason: 'reengagement_agent_error',
      generationError: {
        name: 'Error',
        message: 'No output generated.',
      },
    });
  });

  it('uses LLM for booking_incomplete instead of hard-coding missing fields', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '还差一些报名资料，你方便继续补充一下吗？我这边好接着看。',
        reason: 'booking collection is incomplete',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState({
        collectedFields: {
          name: { value: '张三', producer: 'candidate_quote', at: Date.now() },
        },
      }),
    });

    expect(llm.generateStructured).toHaveBeenCalled();
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe(
      '还差一些报名资料，你方便继续补充一下吗？我这边好接着看。',
    );
    expect(llm.generateStructured.mock.calls[0][0]).not.toHaveProperty('prompt');
    expect(llm.generateStructured.mock.calls[0][0].messages).toEqual(memoryRecall.recentMessages);
    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('已收集资料项：姓名');
    expect(system).not.toContain('"collectedFields"');
    expect(system).not.toContain('张三');
    expect(system).toContain('招募经理');
    expect(system).toContain('候选人看到的这个企微账号就是你本人');
    // 内部类名不应作为人设泄漏进 prompt
    expect(llm.generateStructured.mock.calls[0][0].system).not.toContain('ReengagementAgent');
    expect(llm.generateStructured.mock.calls[0][0].system).not.toContain('booking_incomplete');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('收资未完成');
  });

  it('injects processed memory (fact lines + cleaned recent messages) and logs it to the agent request', async () => {
    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('address_missing')!,
      jobData: job('address_missing'),
      state: baseState(),
      messageId: 'batch-1',
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe('你方便发下位置吗？我这边好按附近方向给你看。');
    expect(memory.recallForProactiveFollowUp).toHaveBeenCalledWith('corp-1', 'user-1', 'sess-1');
    const request = llm.generateStructured.mock.calls[0][0];
    expect(request).not.toHaveProperty('prompt');
    expect(request.messages).toEqual(memoryRecall.recentMessages);
    expect(request).not.toHaveProperty('tools');
    // 只注入当前场景，不再罗列全部场景目录
    expect(request.system).not.toContain('# 可执行的复聊任务');
    expect(request.system).not.toContain('opening_no_reply');
    expect(request.system).not.toContain('address_missing');
    expect(request.system).toContain('# 本次需要完成的任务');
    expect(request.system).toContain('任务名称：缺定位');
    // 结构化事实进入 system；近期对话按 Generator 的原生 roles 进入 messages。
    expect(request.system).not.toContain('## 记忆系统快照');
    expect(request.system).not.toContain('"messageWindow"');
    expect(request.system).not.toContain('## 近期对话');
    expect(request.system).toContain('历史表达，必须以该条消息标注的发送时间为基准理解');
    expect(request.system).toContain('## 已知事实');
    expect(request.system).toContain('意向城市: 上海');
    // 保留与 Generator 完全相同的角色与时间后缀，不再二次拆解和改写。
    expect(request.messages[1].content).toContain('消息发送时间：2026-06-24 09:56 星期三');
    expect(request.system).not.toContain('内部追踪上下文');
    expect(request.system).not.toContain('rolloutEnabled');
    expect(request.system).not.toContain('shadow');
    expect(result.agentRequest).toMatchObject({
      reengagementInput: expect.objectContaining({
        trigger: expect.objectContaining({
          scenario: expect.objectContaining({ code: 'address_missing' }),
          messageId: 'batch-1',
        }),
        memory: expect.objectContaining({
          recentMessages: [
            {
              role: 'user',
              content: '我在静安\n[消息发送时间：2026-06-24 09:55 星期三]',
            },
            {
              role: 'assistant',
              content: '你在哪个地铁站附近呀？\n[消息发送时间：2026-06-24 09:56 星期三]',
            },
          ],
          factLines: ['- 意向城市: 上海（置信度: high，来源: llm）'],
        }),
      }),
    });
    const reengagementInput = result.agentRequest?.reengagementInput as { memory: unknown };
    expect(reengagementInput.memory).toBe(memoryRecall);
  });

  it.each([
    {
      scenarioCode: 'opening_no_reply' as const,
      included: ['- 意向城市: 上海'],
      excluded: ['- 应聘门店: 测试门店', '- 意向薪资: 8000', '- 面试时间: 明天10:00'],
    },
    {
      scenarioCode: 'address_missing' as const,
      included: ['- 意向城市: 上海'],
      excluded: ['- 应聘门店: 测试门店', '- 意向薪资: 8000', '- 面试时间: 明天10:00'],
    },
    {
      scenarioCode: 'store_presented_no_reply' as const,
      included: ['- 应聘门店: 测试门店', '- 意向薪资: 8000', '- 意向城市: 上海'],
      excluded: ['- 面试时间: 明天10:00', '- 需携带材料: 身份证'],
    },
    {
      scenarioCode: 'booking_incomplete' as const,
      included: ['（本场景无需额外结构化事实）'],
      excluded: ['- 应聘门店: 测试门店', '- 意向薪资: 8000', '- 意向城市: 上海'],
    },
    {
      scenarioCode: 'interview_reminder' as const,
      included: ['- 项目/门店：实时项目', '- 岗位：实时岗位', '- 面试地址：实时地址'],
      excluded: [
        '- 应聘门店: 测试门店',
        '- 面试时间: 明天10:00',
        '- 面试地点: 测试大厦',
        '- 需携带材料: 身份证',
        '- 意向薪资: 8000',
        '- 意向城市: 上海',
      ],
    },
    {
      scenarioCode: 'post_interview_followup' as const,
      included: ['- 项目/门店：实时项目', '- 岗位：实时岗位', '- 面试地址：实时地址'],
      excluded: [
        '- 应聘门店: 测试门店',
        '- 面试时间: 明天10:00',
        '- 面试地点: 测试大厦',
        '- 需携带材料: 身份证',
        '- 意向薪资: 8000',
        '- 意向城市: 上海',
      ],
    },
    {
      scenarioCode: 'new_job_for_waiting' as const,
      included: ['- 意向薪资: 8000', '- 意向城市: 上海'],
      excluded: ['- 应聘门店: 测试门店', '- 面试时间: 明天10:00', '- 需携带材料: 身份证'],
    },
  ])(
    'injects only relevant structured facts for $scenarioCode',
    async ({ scenarioCode, included, excluded }) => {
      memoryRecall.recentMessages = [];
      memoryRecall.factLines = [
        '- 姓名: 张三',
        '- 应聘门店: 测试门店',
        '- 应聘岗位: 测试岗位',
        '- 意向薪资: 8000',
        '- 意向城市: 上海',
        '- 面试时间: 明天10:00',
        '- 面试地点: 测试大厦',
        '- 需携带材料: 身份证',
      ];

      await reengagementAgent.compose({
        sessionRef,
        scenario: getScenario(scenarioCode)!,
        jobData: job(scenarioCode, {
          expectedInterviewAt: Date.UTC(2026, 5, 25, 2, 0, 0),
        }),
        state: baseState({
          presentedStores: [{ jobId: 1 }],
          terminal: 'booked',
          interviewAt: Date.UTC(2026, 5, 25, 2, 0, 0),
        } as Partial<ReengagementSessionState>),
        ...(scenarioCode === 'interview_reminder' || scenarioCode === 'post_interview_followup'
          ? {
              bookingContext: liveBookingContext({
                projectName: '实时项目',
                jobName: '实时岗位',
                interviewAddress: '实时地址',
              }),
            }
          : {}),
      });

      const system = llm.generateStructured.mock.calls.at(-1)?.[0].system as string;
      for (const fact of included) expect(system).toContain(fact);
      for (const fact of excluded) expect(system).not.toContain(fact);
      expect(system).not.toContain('- 姓名: 张三');
    },
  );

  it('does not locally enforce reply length', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '复'.repeat(81),
        reason: 'length is governed by prompt not local code',
      },
      usage: {},
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('opening_no_reply')!,
      jobData: job('opening_no_reply'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe('复'.repeat(81));
  });

  it('removes candidate identifiers and facts irrelevant to the current scenario', async () => {
    memoryRecall.recentMessages = [
      { role: 'user', content: '我叫张三，手机号13800000000。' },
      { role: 'assistant', content: '张三，资料还差一点。' },
    ];
    memoryRecall.factLines = [
      '- 姓名: 张三（置信度: high，来源: user_text）',
      '- 联系方式: 13800000000',
      '- 年龄: 28',
      '- 意向城市: 上海（置信度: high，来源: llm）',
    ];

    await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete', {
        channelIdentity: { candidateName: '桃木小鱼' },
      }),
      state: baseState({
        collectedFields: {
          name: { value: '张三', producer: 'candidate_quote', at: Date.now() },
          phone: { value: '13800000000', producer: 'candidate_quote', at: Date.now() },
        },
      }),
    });

    const call = llm.generateStructured.mock.calls[0][0];
    const system = call.system as string;
    const serializedMessages = JSON.stringify(call.messages);
    expect(system).toContain('绝对禁止用候选人的姓名、昵称、企微显示名');
    expect(system).toContain('已收集资料项：姓名、手机号');
    expect(serializedMessages).toContain('（姓名已省略）');
    expect(serializedMessages).toContain('（手机号已省略）');
    expect(system).not.toContain('- 意向城市: 上海');
    expect(system).not.toContain('张三');
    expect(system).not.toContain('桃木小鱼');
    expect(system).not.toContain('13800000000');
    expect(system).not.toContain('- 年龄: 28');
    expect(system).not.toContain('置信度:');
    expect(system).not.toContain('来源:');
    expect(serializedMessages).not.toContain('张三');
    expect(serializedMessages).not.toContain('桃木小鱼');
    expect(serializedMessages).not.toContain('13800000000');
  });

  it('blocks a generated reply that still addresses the candidate by name', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '张三，方便把剩下的资料补充一下吗？',
        reason: '提醒补资料',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState({
        collectedFields: {
          name: { value: '张三', producer: 'candidate_quote', at: Date.now() },
        },
      }),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('candidate_name_in_reply');
    expect(result.agentRequest).toMatchObject({
      validationReason: 'candidate_name_in_reply',
    });
  });

  it('blocks a reply that verbatim repeats the trailing assistant segments (merged with different punctuation)', async () => {
    // 生产 badcase：booking_incomplete 触达把 30 分钟前主链路的 4 段回复合并重发，
    // 仅分段方式和句末标点不同。
    memoryRecall.recentMessages = [
      { role: 'user', content: '这个是需要线下面试嘛\n[消息发送时间：2026-06-24 09:59 星期三]' },
      { role: 'user', content: '是不是不包吃住啊\n[消息发送时间：2026-06-24 09:59 星期三]' },
      {
        role: 'assistant',
        content:
          '这家是 AI 面试，手机上就能做，不用跑门店哈\n[消息发送时间：2026-06-24 10:03 星期三]',
      },
      {
        role: 'assistant',
        content: '也不包吃住，吃饭需要自理\n[消息发送时间：2026-06-24 10:03 星期三]',
      },
      {
        role: 'assistant',
        content:
          '面试安排在工作日 10:00-19:00（周二到周五都行），你看哪天方便\n[消息发送时间：2026-06-24 10:04 星期三]',
      },
      {
        role: 'assistant',
        content:
          '另外确认下，如果这家店人手不够，能接受调配到附近其他必胜客门店上班吗\n[消息发送时间：2026-06-24 10:04 星期三]',
      },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message:
          '这家是 AI 面试，手机上就能做，不用跑门店哈\n\n也不包吃住，吃饭需要自理\n\n面试安排在工作日 10:00-19:00（周二到周五都行），你看哪天方便\n\n另外确认下，如果这家店人手不够，能接受调配到附近其他必胜客门店上班吗',
        reason: '候选人询问面试形式和是否包吃住，需如实回答并继续推进约面',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('duplicate_of_recent_assistant_reply');
    expect(result.agentRequest).toMatchObject({
      validationReason: 'duplicate_of_recent_assistant_reply',
    });
    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('禁止原样或轻改后重发同样内容');
  });

  it('blocks a reply that copies a single earlier assistant message', async () => {
    memoryRecall.recentMessages = [
      {
        role: 'assistant',
        content:
          '资料收到啦，剩下的补齐后我就能帮你安排面试\n[消息发送时间：2026-06-24 09:56 星期三]',
      },
      { role: 'user', content: '好的\n[消息发送时间：2026-06-24 09:57 星期三]' },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '资料收到啦，剩下的补齐后我就能帮你安排面试',
        reason: '提醒补资料',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('duplicate_of_recent_assistant_reply');
  });

  it('does not block a fresh nudge that only briefly echoes earlier context', async () => {
    memoryRecall.recentMessages = [
      {
        role: 'assistant',
        content:
          '面试安排在工作日 10:00-19:00（周二到周五都行），你看哪天方便\n[消息发送时间：2026-06-24 10:04 星期三]',
      },
    ];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '剩下的资料随时可以发我哈，补齐了就能帮你把面试定下来',
        reason: '提醒补资料',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete'),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.validationReason).toBeUndefined();
  });

  it('does not drop a reply when a one-character nickname appears only as ordinary text', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '你方便把位置发一下吗？我好按附近门店给你看。',
        reason: '询问位置',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('booking_incomplete')!,
      jobData: job('booking_incomplete', {
        channelIdentity: { candidateName: '好' },
      }),
      state: baseState(),
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.validationReason).toBeUndefined();
  });

  it('generates escalated store copy with a future-tense group invite preview', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '这批新岗位也不太感兴趣吗？稍后邀请你进兼职岗位群，可以继续看看其他机会。',
        reason: '已经是第二轮扩面后的沉默，需要确认兴趣并预告后续拉群',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('store_presented_no_reply')!,
      jobData: job('store_presented_no_reply', { escalateToGroupInvite: true }),
      state: baseState({
        presentedStores: [{ jobId: 519709 }],
        storePresentationRounds: 2,
      }),
    });

    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('询问候选人是否对这些机会不感兴趣');
    expect(system).toContain('拉群只能用将来或待执行时态');
    expect(system).toContain('目前尚未执行');
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toContain('稍后邀请你进兼职岗位群');
    expect(result.outcome.reply?.text).not.toMatch(/已拉|已经进群|已加入/u);
  });

  it('rejects only a false completed group-invite claim and accepts the corrected preview', async () => {
    llm.generateStructured
      .mockResolvedValueOnce({
        output: {
          decision: 'send',
          blockReason: 'none',
          message: '这些岗位不感兴趣吗？已经拉你进兼职岗位群了。',
          reason: '第二轮扩面收口',
        },
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      })
      .mockResolvedValueOnce({
        output: {
          decision: 'send',
          blockReason: 'none',
          message: '这些岗位不感兴趣吗？稍后邀请你进兼职岗位群继续看看。',
          reason: '第二轮扩面收口',
        },
        usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
      });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('store_presented_no_reply')!,
      jobData: job('store_presented_no_reply', { escalateToGroupInvite: true }),
      state: baseState({ presentedStores: [{ jobId: 519709 }] }),
    });

    expect(llm.generateStructured).toHaveBeenCalledTimes(2);
    expect(llm.generateStructured.mock.calls[1][0].system).toContain(
      'group_invite_completed_claim',
    );
    expect(result.outcome.kind).toBe('reply');
    expect(result.outcome.reply?.text).toBe('这些岗位不感兴趣吗？稍后邀请你进兼职岗位群继续看看。');
  });

  it('builds the onboarding prompt without tools or unsupported employment claims', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'send',
        blockReason: 'none',
        message: '最近入职进展还顺利吗？有遇到什么问题需要协助可以跟我说。',
        reason: '工单仍是面试成功，适合确认入职进展',
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('post_interview_onboarding')!,
      jobData: job('post_interview_onboarding', { workOrderId: 901 }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext({
        workOrderId: 901,
        currentStatus: '面试成功',
        interviewAt: undefined,
      }),
    });

    const request = llm.generateStructured.mock.calls[0][0];
    expect(request.system).toContain('确认候选人是否已顺利入职、有没有遇到问题');
    expect(request.system).toContain('不得断言候选人已入职或未入职');
    expect(request.system).toContain('blockReason=candidate_abandoned_onboarding');
    expect(request.system).toContain('blockReason=candidate_reported_onboarded');
    expect(request.system).toContain('面试通过时间：2026/6/24 10:00');
    expect(request).not.toHaveProperty('tools');
    expect(result.outcome.kind).toBe('reply');
  });

  it.each([
    ['candidate_abandoned_onboarding', '我决定不去了，不入职了'],
    ['candidate_reported_onboarded', '我已经入职上岗了'],
  ] as const)('skips onboarding when the candidate reports %s', async (blockReason, content) => {
    memoryRecall.recentMessages = [{ role: 'user', content }];
    llm.generateStructured.mockResolvedValueOnce({
      output: {
        decision: 'skip',
        blockReason,
        message: '',
        reason: `候选人明确表示：${content}`,
      },
      usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 },
    });

    const result = await reengagementAgent.compose({
      sessionRef,
      scenario: getScenario('post_interview_onboarding')!,
      jobData: job('post_interview_onboarding', { workOrderId: 901 }),
      state: baseState({ terminal: 'booked' }),
      bookingContext: liveBookingContext({ workOrderId: 901, currentStatus: '面试成功' }),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe(blockReason);
  });
});
