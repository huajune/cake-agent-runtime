import { ReengagementAgent } from '@agent/reengagement/reengagement.agent';
import { getScenario } from '@agent/reengagement/follow-up-scheduler.service';
import type { FollowUpJob } from '@agent/reengagement/follow-up-scheduler.service';
import type { AuthoritativeSessionState } from '@memory/types/authoritative-session-state.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<AuthoritativeSessionState> = {}): AuthoritativeSessionState => ({
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
          content:
            '你在哪个地铁站附近呀？\n[消息发送时间：2026-06-24 09:56 星期三]',
        },
      ],
      factLines: ['- 意向城市: 上海（置信度: high，来源: llm）'],
    };
    memory = {
      recallForProactiveFollowUp: jest.fn().mockResolvedValue(memoryRecall),
    };
    reengagementAgent = new ReengagementAgent(llm as never, memory as never);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates a structured message with assembled context for interview reminders', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
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
    expect(llm.generateStructured.mock.calls[0][0].system).not.toContain('interview_reminder');
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

  it('corrects “tomorrow” to “today” when an interview reminder fires on the interview date', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
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
      } as Partial<AuthoritativeSessionState>),
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
      expect(system).toContain('即使工单状态仍显示预约有效也必须放弃面试提醒和面试后回访');
      expect(result.outcome.kind).toBe('skipped');
      expect(result.outcome.reply).toBeUndefined();
      expect(result.validationReason).toBe('candidate_cancelled_interview_in_chat');
      expect(result.agentRequest).toMatchObject({
        validationReason: 'candidate_cancelled_interview_in_chat',
        reengagementOutput: {
          decision: 'skip',
          message: '',
        },
      });
    },
  );

  it('uses LLM for booking_incomplete instead of hard-coding missing fields', async () => {
    llm.generateStructured.mockResolvedValue({
      output: {
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
          name: { value: '张三', provenance: 'user_text', at: Date.now() },
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
    expect(system).toContain('招聘顾问');
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
    expect(request.messages[1].content).toContain(
      '消息发送时间：2026-06-24 09:56 星期三',
    );
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
              content:
                '你在哪个地铁站附近呀？\n[消息发送时间：2026-06-24 09:56 星期三]',
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
        } as Partial<AuthoritativeSessionState>),
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
          name: { value: '张三', provenance: 'user_text', at: Date.now() },
          phone: { value: '13800000000', provenance: 'user_text', at: Date.now() },
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
          name: { value: '张三', provenance: 'user_text', at: Date.now() },
        },
      }),
    });

    expect(result.outcome.kind).toBe('skipped');
    expect(result.validationReason).toBe('candidate_name_in_reply');
    expect(result.agentRequest).toMatchObject({
      validationReason: 'candidate_name_in_reply',
    });
  });

  it('does not drop a reply when a one-character nickname appears only as ordinary text', async () => {
    llm.generateStructured.mockResolvedValueOnce({
      output: {
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
});
