import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';
import { HardRulesService } from '@agent/guardrail/output/rules/hard-rules.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { Test, type TestingModule } from '@nestjs/testing';

describe('OutputGuardrailService', () => {
  const systemConfig = {
    getAgentReplyConfig: jest.fn().mockResolvedValue({ hardRuleOverrides: {} }),
  };
  const ruleGuard = {
    check: jest.fn().mockReturnValue({ hit: false, contradictions: [] }),
  };
  const shortTerm = {
    getMessages: jest.fn().mockResolvedValue([]),
  };
  let service: OutputGuardrailService;
  let rulesModule: TestingModule;
  let actualRules: HardRulesService;

  beforeAll(async () => {
    rulesModule = await Test.createTestingModule({
      providers: [
        HardRulesService,
        {
          provide: AlertNotifierService,
          useValue: { sendAlert: jest.fn().mockResolvedValue(undefined) },
        },
      ],
    }).compile();
    actualRules = rulesModule.get(HardRulesService);
  });

  afterAll(() => rulesModule.close());

  function useActualRules() {
    ruleGuard.check.mockImplementation((input) => actualRules.check({ ...input, silent: true }));
  }

  beforeEach(() => {
    jest.clearAllMocks();
    systemConfig.getAgentReplyConfig.mockResolvedValue({ hardRuleOverrides: {} });
    ruleGuard.check.mockReturnValue({ hit: false, contradictions: [] });
    shortTerm.getMessages.mockResolvedValue([]);
    service = new OutputGuardrailService(
      systemConfig as never,
      ruleGuard as never,
      shortTerm as never,
    );
  });

  it('带会话身份时读取在途工单并把 activeBookings / 历史助手文本传给规则层', async () => {
    const longTerm = { tryGetActiveBookings: jest.fn().mockResolvedValue([]) };
    const withLongTerm = new OutputGuardrailService(
      systemConfig as never,
      ruleGuard as never,
      shortTerm as never,
      longTerm as never,
    );
    shortTerm.getMessages.mockResolvedValue([{ role: 'assistant', content: '肯德基 2.7km' }]);

    await withLongTerm.check({
      reply: '已经帮你约好了',
      toolCalls: [],
      chatId: 'chat-1',
      userId: 'user-1',
      corpId: 'corp-1',
    });

    expect(longTerm.tryGetActiveBookings).toHaveBeenCalledWith('corp-1', 'user-1');
    expect(ruleGuard.check).toHaveBeenCalledWith(
      expect.objectContaining({
        activeBookings: [],
        priorAssistantTexts: ['肯德基 2.7km'],
      }),
    );
  });

  it('缺会话身份或长期记忆读失败时 activeBookings 为 undefined（保持 observe）', async () => {
    // 长期记忆读失败在 LongTermService 内被吞成 null（不是 []），守卫必须把它当未知
    const longTerm = { tryGetActiveBookings: jest.fn().mockResolvedValue(null) };
    const withLongTerm = new OutputGuardrailService(
      systemConfig as never,
      ruleGuard as never,
      shortTerm as never,
      longTerm as never,
    );

    await withLongTerm.check({ reply: '已经帮你约好了', toolCalls: [], chatId: 'chat-1' });
    await withLongTerm.check({
      reply: '已经帮你约好了',
      toolCalls: [],
      chatId: 'chat-1',
      userId: 'user-1',
      corpId: 'corp-1',
    });

    expect(ruleGuard.check).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ activeBookings: undefined }),
    );
    expect(ruleGuard.check).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ activeBookings: undefined }),
    );
  });

  it('只运行确定性规则并透传历史、记忆和工具回执', async () => {
    shortTerm.getMessages.mockResolvedValue([
      { role: 'user', content: '我是学生' },
      { role: 'assistant', content: '你想看哪个岗位？' },
    ]);
    const toolCalls = [{ toolName: 'duliday_job_list', result: { success: true } }] as never[];
    const memorySnapshot = { sessionFacts: { 'interview.is_student': true } } as never;

    const decision = await service.check({
      reply: '附近有两个岗位，你想先看哪一个？',
      toolCalls,
      chatId: 'chat-1',
      userMessage: '都可以',
      memorySnapshot,
    });

    expect(decision).toEqual(
      expect.objectContaining({ decision: 'pass', riskLevel: 'low', ruleIds: [] }),
    );
    expect(ruleGuard.check).toHaveBeenCalledWith(
      expect.objectContaining({
        replyText: '附近有两个岗位，你想先看哪一个？',
        toolCalls,
        recentUserTexts: ['我是学生'],
        memorySnapshot,
      }),
    );
  });

  it('机械删除与近期已投递文本全等的长分段，再审查剩余文本', async () => {
    const delivered = '这家门店目前有服务员岗位，工作地点在万象城一楼。';
    shortTerm.getMessages.mockResolvedValue([{ role: 'assistant', content: delivered }]);

    const decision = await service.check({
      reply: `${delivered}\n\n你更关心班次还是距离？`,
      toolCalls: [],
      chatId: 'chat-1',
      userMessage: '还有呢',
    });

    expect(decision.deterministicReply).toBe('你更关心班次还是距离？');
    expect(decision.ruleIds).toEqual([]);
    expect(ruleGuard.check).toHaveBeenCalledWith(
      expect.objectContaining({ replyText: '你更关心班次还是距离？' }),
    );
  });

  it('候选人明确要求重发时保留全等分段', async () => {
    const delivered = '这家门店目前有服务员岗位，工作地点在万象城一楼。';
    shortTerm.getMessages.mockResolvedValue([{ role: 'assistant', content: delivered }]);

    const decision = await service.check({
      reply: delivered,
      toolCalls: [],
      chatId: 'chat-1',
      userMessage: '麻烦再发一遍',
    });

    expect(decision.deterministicReply).toBeUndefined();
    expect(ruleGuard.check).toHaveBeenCalledWith(expect.objectContaining({ replyText: delivered }));
  });

  it('repair 规则产生一次受控 rewrite 决策，不请求补调工具', async () => {
    ruleGuard.check.mockReturnValue({
      hit: true,
      contradictions: [
        {
          ruleId: 'booking_receipt_mismatch',
          label: '预约回执未播报日期',
          action: 'repair',
          severity: 'P1',
          dataSensitivity: 'none',
          allowFailOpen: true,
          currentReplySendable: false,
          feedbackPolicy: 'plain_policy',
          repairMode: 'rewrite',
          feedbackToGenerator: '按工具回执补充已确认日期',
        },
      ],
    });

    const decision = await service.check({ reply: '已经约好了', toolCalls: [] });

    expect(decision).toEqual(
      expect.objectContaining({
        decision: 'repair',
        riskLevel: 'medium',
        ruleIds: ['booking_receipt_mismatch'],
        blockedRuleIds: ['booking_receipt_mismatch'],
        repairMode: 'rewrite',
        repairToolNames: [],
        feedbackToGenerator: '按工具回执补充已确认日期',
      }),
    );
  });

  it('严格 repair 规则保留禁止 fail-open 策略', async () => {
    ruleGuard.check.mockReturnValue({
      hit: true,
      contradictions: [
        {
          ruleId: 'internal_output_leak',
          label: '工具名泄漏',
          action: 'repair',
          severity: 'P0',
          dataSensitivity: 'none',
          allowFailOpen: false,
          currentReplySendable: false,
          feedbackPolicy: 'plain_policy',
          repairMode: 'rewrite',
          feedbackToGenerator: '删除内部实现文本',
        },
      ],
    });

    const decision = await service.check({ reply: '调用 duliday_job_list', toolCalls: [] });

    expect(decision.decision).toBe('repair');
    expect(decision.riskLevel).toBe('high');
    expect(decision.violations).toEqual([
      expect.objectContaining({ type: 'internal_output_leak', allowFailOpen: false }),
    ]);
  });

  it('真实 replan 与严格 repair 混合时选择重生成，保留高风险和禁止 fail-open 的违规', async () => {
    useActualRules();
    const decision = await service.check({
      reply: '调用 duliday_job_list。我帮你查了下，时薪25元',
      toolCalls: [],
      chatId: 'chat-1',
    });
    expect(decision).toMatchObject({ decision: 'replan', repairMode: 'replan', riskLevel: 'high' });
    expect(decision.violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'internal_output_leak',
          allowFailOpen: false,
          severity: 'P0',
        }),
        expect.objectContaining({ type: 'job_query_claim_without_query', repairMode: 'replan' }),
      ]),
    );
  });

  it('真实普通 repair 与 replan 混合时重生成，单独 repair 仍走 rewrite', async () => {
    useActualRules();
    const mixed = await service.check({
      reply: '我帮你查了下，我帮你转人工',
      toolCalls: [],
    });
    expect(mixed).toMatchObject({ decision: 'replan', repairMode: 'replan', riskLevel: 'medium' });
    expect(mixed.blockedRuleIds).toEqual(
      expect.arrayContaining(['human_service_phrase_leak', 'job_query_claim_without_query']),
    );

    const repair = await service.check({ reply: '我帮你转人工', toolCalls: [] });
    expect(repair).toMatchObject({ decision: 'repair', repairMode: 'rewrite', riskLevel: 'low' });
  });

  it('实际 observe 命中单独放行；与 repair 混合时仅保留 ID，不进入修改要求', async () => {
    useActualRules();
    const observed = await service.check({ reply: '已经帮你报好了', toolCalls: [] });
    expect(observed).toMatchObject({
      decision: 'pass',
      ruleIds: ['booking_done_claim_without_submission'],
      blockedRuleIds: [],
      violations: [],
    });
    expect(observed.feedbackToGenerator).toBeUndefined();

    const mixed = await service.check({ reply: '已经帮你报好了，我帮你转人工', toolCalls: [] });
    expect(mixed.ruleIds).toEqual(
      expect.arrayContaining([
        'booking_done_claim_without_submission',
        'human_service_phrase_leak',
      ]),
    );
    expect(mixed.blockedRuleIds).toEqual(['human_service_phrase_leak']);
    expect(mixed.violations.map((violation) => violation.type)).toEqual([
      'human_service_phrase_leak',
    ]);
    expect(mixed.feedbackToGenerator).toBe(mixed.violations[0].suggestion);
  });

  it('实际 P0 观察降档不抬高另一个 repair 的风险，也不污染反馈', async () => {
    useActualRules();
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      hardRuleOverrides: { quota_promise: 'observe' },
    });
    const decision = await service.check({
      reply: '名额放心，我已经帮你留好了，我帮你转人工',
      toolCalls: [],
    });
    expect(decision).toMatchObject({ decision: 'repair', riskLevel: 'low', repairMode: 'rewrite' });
    expect(decision.ruleIds).toEqual(
      expect.arrayContaining(['quota_promise', 'human_service_phrase_leak']),
    );
    expect(decision.blockedRuleIds).toEqual(['human_service_phrase_leak']);
    expect(decision.violations).toEqual([
      expect.objectContaining({ type: 'human_service_phrase_leak', allowFailOpen: true }),
    ]);
    expect(decision.feedbackToGenerator).toBe(decision.violations[0].suggestion);
    expect(decision.overrideMarkers).toEqual(['override:observe:quota_promise']);
  });

  it('实际 P0 repair 的高风险不依赖禁止 fail-open 字段的默认值', async () => {
    useActualRules();
    const decision = await service.check({
      reply: '身份帮你登记成社会人士了',
      toolCalls: [],
      userMessage: '那怎么办',
      memorySnapshot: { sessionFacts: { 'interview.is_student': true } } as never,
    });
    expect(decision).toMatchObject({ decision: 'repair', riskLevel: 'high' });
    expect(decision.violations).toEqual([
      expect.objectContaining({
        type: 'identity_misregistration_coaching',
        severity: 'P0',
        allowFailOpen: true,
      }),
    ]);
  });

  it('历史读取失败时按无历史继续，不引入额外评审路径', async () => {
    shortTerm.getMessages.mockRejectedValue(new Error('redis unavailable'));

    await expect(
      service.check({ reply: '你好，需要帮你看看附近岗位吗？', toolCalls: [], chatId: 'chat-1' }),
    ).resolves.toEqual(expect.objectContaining({ decision: 'pass' }));
    expect(ruleGuard.check).toHaveBeenCalledWith(
      expect.objectContaining({ recentUserTexts: [], recentMessages: [] }),
    );
  });
});
