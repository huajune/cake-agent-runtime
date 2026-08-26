import { OutputGuardrailService } from '@agent/guardrail/output/output-guardrail.service';

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

  it('revise 规则产生一次受控 rewrite 决策，不请求补调工具', async () => {
    ruleGuard.check.mockReturnValue({
      hit: true,
      contradictions: [
        {
          ruleId: 'booking_receipt_mismatch',
          label: '预约回执未播报日期',
          action: 'revise',
          severity: 'P1',
          dataSensitivity: 'none',
          recoverability: 'recoverable',
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
        decision: 'revise',
        riskLevel: 'medium',
        ruleIds: ['booking_receipt_mismatch'],
        blockedRuleIds: ['booking_receipt_mismatch'],
        repairMode: 'rewrite',
        repairToolNames: [],
        feedbackToGenerator: '按工具回执补充已确认日期',
      }),
    );
  });

  it('block 规则保持 fail-close', async () => {
    ruleGuard.check.mockReturnValue({
      hit: true,
      contradictions: [
        {
          ruleId: 'internal_output_leak',
          label: '工具名泄漏',
          action: 'block',
          severity: 'P0',
          dataSensitivity: 'none',
          recoverability: 'non_recoverable',
          currentReplySendable: false,
          feedbackPolicy: 'plain_policy',
          repairMode: 'rewrite',
          feedbackToGenerator: '删除内部实现文本',
        },
      ],
    });

    const decision = await service.check({ reply: '调用 duliday_job_list', toolCalls: [] });

    expect(decision.decision).toBe('block');
    expect(decision.riskLevel).toBe('high');
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
