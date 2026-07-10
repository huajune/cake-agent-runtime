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
    // recallForProactiveFollowUp 返回的是已处理结果：时间注入已剥离、facts 已渲染成字段行。
    memoryRecall = {
      recentMessages: [
        { role: 'user', content: '我在静安' },
        { role: 'assistant', content: '你在哪个地铁站附近呀？' },
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
      }),
      state: baseState({ terminal: 'booked' }),
    });

    expect(llm.generateStructured).toHaveBeenCalledWith(
      expect.objectContaining({
        system: expect.stringContaining('本 Agent 不开放任何工具'),
        outputName: 'ReengagementMessage',
        prompt: '请根据以上上下文生成本次复聊消息。',
      }),
    );
    expect(llm.generateStructured.mock.calls[0][0].system).not.toContain('interview_reminder');
    expect(llm.generateStructured.mock.calls[0][0].system).toContain('# 已核验的最小上下文');
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
    expect(llm.generateStructured.mock.calls[0][0].prompt).toBe(
      '请根据以上上下文生成本次复聊消息。',
    );
    expect(llm.generateStructured.mock.calls[0][0]).not.toHaveProperty('messages');
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
    expect(request.prompt).toBe('请根据以上上下文生成本次复聊消息。');
    expect(request).not.toHaveProperty('messages');
    expect(request).not.toHaveProperty('tools');
    // 只注入当前场景，不再罗列全部场景目录
    expect(request.system).not.toContain('# 可执行的复聊任务');
    expect(request.system).not.toContain('opening_no_reply');
    expect(request.system).not.toContain('address_missing');
    expect(request.system).toContain('# 本次需要完成的任务');
    expect(request.system).toContain('任务名称：缺定位');
    // 记忆走处理后的字段行 + 清洗过的近期对话，而非裸 JSON 快照
    expect(request.system).not.toContain('## 记忆系统快照');
    expect(request.system).not.toContain('"messageWindow"');
    expect(request.system).toContain('## 近期对话');
    expect(request.system).toContain('候选人：我在静安');
    expect(request.system).toContain('## 已知事实');
    expect(request.system).toContain('意向城市: 上海');
    // 注入的时间上下文标记已被 recall 剥离，不应出现在 prompt
    expect(request.system).not.toContain('消息发送时间');
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
            { role: 'user', content: '我在静安' },
            { role: 'assistant', content: '你在哪个地铁站附近呀？' },
          ],
          factLines: ['- 意向城市: 上海（置信度: high，来源: llm）'],
        }),
      }),
    });
    const reengagementInput = result.agentRequest?.reengagementInput as { memory: unknown };
    expect(reengagementInput.memory).toBe(memoryRecall);
  });

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

  it('removes candidate names and unnecessary personal fields from the model prompt', async () => {
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

    const system = llm.generateStructured.mock.calls[0][0].system as string;
    expect(system).toContain('绝对禁止用候选人的姓名、昵称、企微显示名');
    expect(system).toContain('已收集资料项：姓名、手机号');
    expect(system).toContain('（姓名已省略）');
    expect(system).toContain('（手机号已省略）');
    expect(system).toContain('- 意向城市: 上海');
    expect(system).not.toContain('张三');
    expect(system).not.toContain('桃木小鱼');
    expect(system).not.toContain('13800000000');
    expect(system).not.toContain('- 年龄: 28');
    expect(system).not.toContain('置信度:');
    expect(system).not.toContain('来源:');
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
});
