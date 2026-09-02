import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import type { GeneratorRunResult } from '@agent/generator/generator.types';
import { CallerKind } from '@enums/agent.enum';

describe('AgentRunnerService.runTurn', () => {
  let generator: { invoke: jest.Mock };
  let outputGuard: { check: jest.Mock };
  let inputGuard: { precheckInputRisk: jest.Mock; evaluate: jest.Mock };
  let guardrailReviews: { recordReview: jest.Mock };
  let replyRepairAgent: { repair: jest.Mock };
  let replyRepairContextProvider: { build: jest.Mock };
  let tracer: { emit: jest.Mock };
  let service: AgentRunnerService;

  const passDecision = {
    decision: 'pass' as const,
    riskLevel: 'low' as const,
    violations: [],
    ruleIds: [],
    blockedRuleIds: [],
    repairMode: 'rewrite' as const,
  };

  const sessionRef = { corpId: 'c1', userId: 'u1', sessionId: 's1' };

  const makeResult = (over: Partial<GeneratorRunResult>): GeneratorRunResult => ({
    text: '',
    steps: 1,
    agentSteps: [],
    toolCalls: [],
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    ...over,
  });

  beforeEach(() => {
    generator = { invoke: jest.fn() };
    outputGuard = { check: jest.fn().mockResolvedValue(passDecision) };
    inputGuard = {
      precheckInputRisk: jest.fn().mockResolvedValue({ hit: false }),
      evaluate: jest.fn().mockResolvedValue({ decision: 'pass' }),
    };
    guardrailReviews = { recordReview: jest.fn().mockResolvedValue('inserted') };
    replyRepairAgent = { repair: jest.fn().mockResolvedValue('重写后的自然回复') };
    replyRepairContextProvider = { build: jest.fn().mockResolvedValue(undefined) };
    tracer = { emit: jest.fn() };
    service = new AgentRunnerService(
      generator as never,
      outputGuard as never,
      inputGuard as never,
      guardrailReviews as never,
      replyRepairAgent as never,
      replyRepairContextProvider as never,
      undefined,
      tracer as never,
    );
  });

  it('proactive turn injects directive + readonly toolMode and returns a reply outcome', async () => {
    generator.invoke.mockResolvedValue(makeResult({ text: '在吗，之前看的岗位还考虑吗？' }));

    const outcome = await service.runTurn({
      sessionRef,
      trigger: {
        kind: 'proactive',
        directive: '提醒候选人开场未回复',
        scenarioCode: 'opening_no_reply',
      },
    });

    const params = generator.invoke.mock.calls[0][0];
    expect(params.toolMode).toBe('readonly');
    expect(params.proactiveDirective).toBe('提醒候选人开场未回复');
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('考虑');
    expect(outcome.scenarioCode).toBe('opening_no_reply');
  });

  it('sanitizes outbound reply text in runner outcome before any channel delivery', async () => {
    const rawText = `<think>内部推理</think>
**收到**，[表情消息] 好的


1. 身高大概多少呀？
2. 目前是暑假工还是能长期做？`;
    generator.invoke.mockResolvedValue(
      makeResult({
        text: rawText,
        responseMessages: [
          {
            role: 'assistant',
            parts: [{ type: 'text', text: rawText }],
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '资料发你了' },
    });

    const expected = `收到，好的

1. 身高大概多少呀？
2. 目前是暑假工还是能长期做？`;
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(expected);
    expect(outcome.generatedText).toBe(expected);
    expect(outcome.responseMessages?.[0]?.parts).toEqual([{ type: 'text', text: expected }]);
    expect(outcome.reply?.text).not.toContain('可以选');
    expect(outcome.reply?.text).not.toContain('<think>');
    expect(outcome.reply?.text).not.toContain('[表情消息]');
  });

  it('adopts deterministic segment-pruned reply without entering model repair', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '这家目前暂时排不上。\n\n徐汇区还有一家，我继续帮你核实',
        runTurnEnd,
      }),
    );
    outputGuard.check.mockResolvedValue({
      ...passDecision,
      ruleIds: [],
      deterministicReply: '徐汇区还有一家，我继续帮你核实',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: {
        kind: 'inbound',
        userMessage:
          '[图片消息]\n[引用 招聘经理：这家排不上]\n那徐汇呢\n[消息发送时间：2026-08-13 10:24:32]',
      },
    });

    expect(outcome.reply?.text).toBe('徐汇区还有一家，我继续帮你核实');
    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    await outcome.runTurnEnd?.();
    expect(runTurnEnd).toHaveBeenCalledWith({
      assistantTextOverride: '徐汇区还有一家，我继续帮你核实',
    });
  });

  it('empty text or skip_reply short-circuit maps to skipped', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '',
        toolCalls: [{ toolName: 'skip_reply', args: {}, result: { skipped: true } }],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive: 'x', scenarioCode: 'opening_no_reply' },
    });

    expect(outcome.kind).toBe('skipped');
  });

  it('request_handoff maps to handoff with an outcome-layer sideEffect', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '需要人工',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'modify_appointment', reason: '冲突' },
            result: {
              dispatched: true,
              shortCircuited: true,
              sideEffect: {
                kind: 'general_handoff',
                source: 'agent_tool',
                alertLabel: '候选人要求改期/取消已预约面试',
                reasonCode: 'modify_appointment',
                reason: '冲突',
                recordHandoff: true,
              },
            },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '帮我改约' },
      context: { messageId: 'm1' },
    });

    expect(outcome.kind).toBe('handoff');
    expect(outcome.handoff?.sourceToolCall).toBe('request_handoff');
    expect(outcome.handoff?.reasonCode).toBe('modify_appointment');
    expect(outcome.handoff?.alreadyDispatched).toBe(false);
    expect(outcome.handoff?.idempotencyKey).toBe('s1:handoff:m1');
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        reasonCode: 'modify_appointment',
        recordHandoff: true,
      }),
    ]);
  });

  it('inbound input guard hit returns guardrail_blocked before generator runs', async () => {
    inputGuard.evaluate.mockResolvedValue({
      decision: 'block',
      source: 'input_risk',
      disposition: 'side_effects',
      reasonCode: 'abuse',
      riskType: 'abuse',
      riskLabel: '辱骂',
      reason: '命中辱骂关键词',
      inspectedText: '你们就是骗子',
      sideEffects: [
        {
          kind: 'conversation_risk',
          source: 'regex_intercept',
          riskType: 'abuse',
          riskLabel: '辱骂',
          summary: '候选人消息命中高置信度风险关键词',
          reason: '命中辱骂关键词',
        },
      ],
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '你们就是骗子' },
      context: {
        messageId: 'm-risk',
        contactName: '张三',
        botImId: 'bot-im',
        botUserId: 'manager-1',
      },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual({
      phase: 'inbound',
      source: 'input_guardrail',
      riskType: 'abuse',
      riskLabel: '辱骂',
      reason: '命中辱骂关键词',
      reasonCode: 'abuse',
      inspectedText: '你们就是骗子',
    });
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'conversation_risk',
        source: 'regex_intercept',
        riskType: 'abuse',
      }),
    ]);
    // 观测 P1-2：入站拦截落事件，时间线能看出"这轮为什么没跑 Agent"；正文不进事件
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'inbound_guardrail_block',
        reasonCode: 'abuse',
        riskType: 'abuse',
        riskLabel: '辱骂',
      }),
    );
    expect(tracer.emit).not.toHaveBeenCalledWith(
      expect.objectContaining({ inspectedText: expect.anything() }),
    );
    expect(inputGuard.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'c1',
        chatId: 's1',
        userId: 'u1',
        pauseTargetId: 's1',
        scanContent: '你们就是骗子',
        messageId: 'm-risk',
        contactName: '张三',
        botImId: 'bot-im',
        botUserName: 'manager-1',
      }),
    );
    expect(generator.invoke).not.toHaveBeenCalled();
  });

  it('inbound input guard scan text filters visual placeholder lines inside runner', async () => {
    generator.invoke.mockResolvedValue(makeResult({ text: '收到' }));

    await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '[图片消息]\n你好\n[表情消息]' },
    });

    expect(inputGuard.evaluate).toHaveBeenCalledWith(
      expect.objectContaining({ scanContent: '你好' }),
    );
    expect(generator.invoke).toHaveBeenCalledTimes(1);
  });

  it('request_handoff with shortCircuited=false stays a reply outcome', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '你还没有已确认预约，我先按首次约面帮你看可约时间',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'modify_appointment', reason: '想改期' },
            result: {
              dispatched: false,
              errorType: 'handoff.no_booking',
              shortCircuited: false,
            },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '明天去不了，帮我改一下' },
      context: { messageId: 'm1' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('首次约面');
  });

  it('booking gate hard-reject maps to handoff with alreadyDispatched=false (outcome-layer dispatch)', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '',
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {},
            result: { shortCircuited: true, gateRejected: true, reasonCode: 'job_id_not_recalled' },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '约面试' },
    });

    expect(outcome.kind).toBe('handoff');
    expect(outcome.handoff?.sourceToolCall).toBe('duliday_interview_booking');
    expect(outcome.handoff?.reasonCode).toBe('job_id_not_recalled');
    expect(outcome.handoff?.alreadyDispatched).toBe(false);
  });

  it('modify ownership gate hard-reject directly maps to handoff with the resolved work order', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '',
        toolCalls: [
          {
            toolName: 'duliday_modify_interview_time',
            args: { workOrderId: 450643, newInterviewTime: '2026-07-17 10:00' },
            result: {
              success: false,
              shortCircuited: true,
              gateRejected: true,
              reasonCode: 'modify_appointment',
              errorType: 'modify_interview.work_order_not_in_memory',
              workOrderId: 450643,
              handoffReason: '手机号工单不属于当前微信联系人，已阻止自助改约',
              actionAdvice: '核实联系人关系后人工修改工单',
            },
          },
        ],
      }),
    );

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '确定改到明天上午10点' },
      context: { messageId: 'm-modify-owner-gate' },
    });

    expect(outcome.kind).toBe('handoff');
    expect(outcome.handoff?.sourceToolCall).toBe('duliday_modify_interview_time');
    expect(outcome.handoff?.reasonCode).toBe('modify_appointment');
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        workOrderId: 450643,
        reasonCode: 'modify_appointment',
        reason: '手机号工单不属于当前微信联系人，已阻止自助改约',
      }),
    ]);
  });

  it('generator failure collapses to skipped (reengagement resilience)', async () => {
    generator.invoke.mockRejectedValue(new Error('messages 为空'));

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'proactive', directive: 'x', scenarioCode: 'opening_no_reply' },
    });

    expect(outcome.kind).toBe('skipped');
    expect(outcome.scenarioCode).toBe('opening_no_reply');
  });

  it('inbound generator failure rethrows (channel fallback owns it, no silent skip)', async () => {
    const boom = new Error('llm down');
    generator.invoke.mockRejectedValue(boom);

    await expect(
      service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: '你好' },
      }),
    ).rejects.toThrow('llm down');
  });

  it('output guard block enters one rewrite and adopts the clean revised reply', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '不要新疆户籍的' }));
    replyRepairAgent.repair.mockResolvedValueOnce('这个岗位暂时不合适，我们可以看其他岗位。');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'discriminatory_screening_leak',
            evidence: '命中高敏感规则',
            suggestion: '删除敏感条件',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['discriminatory_screening_leak'],
        blockedRuleIds: ['discriminatory_screening_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有什么岗位' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('这个岗位暂时不合适，我们可以看其他岗位。');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair).toHaveBeenCalledWith(
      expect.objectContaining({
        originalReply: '不要新疆户籍的',
        ruleIds: ['discriminatory_screening_leak'],
      }),
    );
  });

  it('fence-only internal_output_leak strips code fences deterministically without LLM repair', async () => {
    const draft = [
      '是的，这岗是周结，每周三发上周的工资。',
      '',
      '面试时间有周三、周四、周五的 10:30-15:00，你先填下资料，我帮你安排。',
      '',
      '```text',
      '面试要求：先将以下资料补充下发给我，我来帮你约面试',
      '姓名：',
      '联系方式：',
      '面试时间（周三/周四/周五 10:30-15:00 选一天）：',
      '```',
    ].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '回复疑似泄漏 Agent 内部状态/工具实现（pattern=^```）',
            suggestion: '删除泄漏内容',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '这是周接?' },
      context: { messageId: 'trace-fence-strip-1' },
    });

    // 围栏内的报名表模板必须逐字保留，只有围栏标记被剥掉；不进 LLM 重写。
    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('姓名：');
    expect(outcome.reply?.text).toContain('面试时间（周三/周四/周五 10:30-15:00 选一天）：');
    expect(outcome.reply?.text).not.toContain('```');
    // 剥离产物仍送二审，档案标注 fence_stripped 供审计区分修复方式。
    expect(outputGuard.check).toHaveBeenCalledTimes(2);
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'pass',
        reasonCode: 'fence_stripped',
        repaired: true,
        revisedReply: expect.stringContaining('姓名：'),
      }),
    );
  });

  it('mixed reasoning leak is stripped deterministically and archived', async () => {
    const draft = [
      '我应该简洁地回答这两个问题',
      '附近暂时没有合适岗位，有新岗位我及时告诉你。',
    ].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '回复疑似泄漏推理独白',
            suggestion: '删除泄漏内容',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '附近有岗位吗' },
      context: { messageId: 'trace-reasoning-strip-1' },
    });

    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(outcome.reply?.text).toBe('附近暂时没有合适岗位，有新岗位我及时告诉你。');
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'pass',
        reasonCode: 'internal_reasoning_stripped',
        repaired: true,
      }),
    );
  });

  it('reasoning-only leak converges to logged silence without repair', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '</antThinking>' }));
    outputGuard.check.mockResolvedValueOnce({
      decision: 'block',
      riskLevel: 'high',
      violations: [
        {
          type: 'internal_output_leak',
          evidence: '回复疑似泄漏推理残标',
          suggestion: '删除泄漏内容',
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
        },
      ],
      ruleIds: ['internal_output_leak'],
      blockedRuleIds: ['internal_output_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '在吗' },
      context: { messageId: 'trace-reasoning-silence-1' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'block',
        reasonCode: 'internal_reasoning_artifact_silenced',
        repaired: false,
      }),
    );
  });

  // 2026-08-04 审计 P0-1（trace …_1785489639414）：首版整条只有"让同事确认"承诺，
  // 删承诺后无内容可保留，rewrite 曾编出"衣服方面店里没有特殊要求"投递。该形态
  // 直接收敛静默，不进 rewrite。

  // 2026-08-04 审计 P0-2：JSON 信封形态（trace …_1785820152687）——旧链路误判纯残文
  // 整轮静默，把信封里的完整好回复一起吞掉。正解：确定性拆封放出正文，走二审后投递。
  it('JSON envelope reply is unwrapped deterministically instead of being silenced', async () => {
    const draft =
      '{\n"agent_response": "好的，我帮你看下罗湖附近在招的岗位哈～先问下，你倾向哪类工作呀？"\n}';
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '回复疑似泄漏 Agent 内部状态/工具实现（pattern=json）',
            suggestion: '删除泄漏内容',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '罗湖谢谢' },
      context: { messageId: 'trace-envelope-unwrap-1' },
    });

    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(
      '好的，我帮你看下罗湖附近在招的岗位哈～先问下，你倾向哪类工作呀？',
    );
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'pass',
        reasonCode: 'envelope_unwrapped',
        repaired: true,
      }),
    );
  });

  // tool_use 信封（trace …_1785746625937）里的 reason 是内部升级理由不是话术，
  // 必须维持 tool_call_artifact_silenced 直达静默，不得拆封投递。
  it('tool_use envelope stays silenced (not unwrapped)', async () => {
    const draft =
      '{"type":"tool_use","id":"toolu_x","name":"request_handoff","input":{"reason":"候选人追问必胜客十里河店培训期具体天数，岗位数据未明确该信息"}}';
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    outputGuard.check.mockResolvedValueOnce({
      decision: 'block',
      riskLevel: 'high',
      violations: [
        {
          type: 'internal_output_leak',
          evidence: '回复疑似泄漏 Agent 内部状态/工具实现',
          suggestion: '删除泄漏内容',
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
        },
      ],
      ruleIds: ['internal_output_leak'],
      blockedRuleIds: ['internal_output_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '培训几天' },
      context: { messageId: 'trace-envelope-tooluse-1' },
    });

    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(outcome.kind).not.toBe('reply');
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'block',
        reasonCode: 'tool_call_artifact_silenced',
        repaired: false,
      }),
    );
  });

  it('mixed internal leak (fence + tool name) falls back to LLM repair', async () => {
    const draft = ['```json', '{"name":"duliday_job_list"}', '```', '给你看下岗位'].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    replyRepairAgent.repair.mockResolvedValueOnce('帮你看了下附近的岗位，稍后发你详情。');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '回复疑似泄漏 Agent 内部状态/工具实现',
            suggestion: '删除泄漏内容',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有岗位吗' },
      context: { messageId: 'trace-fence-mixed-1' },
    });

    // 剥完围栏仍残留工具名泄漏，确定性快通道不适用，走常规 LLM 重写。
    expect(replyRepairAgent.repair).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('帮你看了下附近的岗位，稍后发你详情。');
  });

  // 2026-07-30 守卫审计 P0-2：2026-07-28 15:05–15:11 模型降级窗口，模型把工具调用
  // 语法当正文吐出，rewrite 在零事实上重写，4/4 编出薪资/门店/伪造报名链接并投递。
  it('tool-call artifact draft converges to silence instead of free-form rewrite', async () => {
    generator.invoke.mockResolvedValueOnce(
      makeResult({ text: 'geocode(address="大良", city="佛山")' }),
    );
    outputGuard.check.mockResolvedValueOnce({
      decision: 'block',
      riskLevel: 'high',
      violations: [
        {
          type: 'internal_output_leak',
          evidence: '回复疑似泄漏 Agent 内部状态/工具实现（pattern=geocode）',
          suggestion: '删除泄漏内容',
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
        },
      ],
      ruleIds: ['internal_output_leak'],
      blockedRuleIds: ['internal_output_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '广东省佛山市顺德区大良' },
      context: { messageId: 'trace-tool-artifact-1' },
    });

    // 残文剥完无一字可留，"其余内容逐字保留"退化成自由创作——不进 repair、不送二审。
    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(outputGuard.check).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(
      expect.objectContaining({
        reasonCode: 'tool_call_artifact_silenced',
        ruleBlocked: true,
      }),
    );
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'block',
        reasonCode: 'tool_call_artifact_silenced',
        repaired: false,
      }),
    );
  });

  // 2026-07-30 守卫审计 P0-3：候选人问日结岗，模型回了一整篇后端接口设计答案，
  // 剥掉围栏后词库不再命中，快通道逐字放行——整篇跨域内容投递给了候选人。
  it('technical-documentation draft skips the fence fast path and goes to LLM repair', async () => {
    const draft = [
      '明白。既然 TjybappHousingConfirm 表中的金额字段已经是"元 × 10000"的整型存储，接口返回时直接透传原值即可。',
      '',
      '```json',
      '{',
      '"confirm_id": "C202310250001",',
      '"amount": 150000',
      '}',
      '```',
      '',
      '### 核心映射规则',
      '| 原始表字段 | 返回JSON字段 | 处理方式 |',
      '| amount | amount | 整型原值透传 |',
    ].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: draft }));
    replyRepairAgent.repair.mockResolvedValueOnce('日结的岗位我帮你留意下，你在哪个区呀？');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '回复疑似泄漏 Agent 内部状态/工具实现（pattern=^```）',
            suggestion: '删除泄漏内容',
            recoverability: 'non_recoverable',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '那有日结的岗吗' },
      context: { messageId: 'trace-fence-techdoc-1' },
    });

    expect(replyRepairAgent.repair).toHaveBeenCalledTimes(1);
    expect(outcome.reply?.text).toBe('日结的岗位我帮你留意下，你在哪个区呀？');
    expect(outcome.reply?.text).not.toContain('TjybappHousingConfirm');
  });

  it('meta narration block converges to silence without repair or handoff side effect', async () => {
    generator.invoke.mockResolvedValueOnce(
      makeResult({ text: '（本轮为真人招募经理与候选人直接沟通，AI 保持静默，不插入回复）' }),
    );
    outputGuard.check.mockResolvedValueOnce({
      decision: 'block',
      riskLevel: 'high',
      violations: [
        {
          type: 'meta_narration_reply',
          evidence: '整条回复是描述 Agent 自身行为的括号旁白',
          suggestion: '本轮应调用 skip_reply',
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
        },
      ],
      ruleIds: ['meta_narration_reply'],
      blockedRuleIds: ['meta_narration_reply'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有的' },
      context: { messageId: 'trace-meta-narration-1' },
    });

    // 不进 repair、不送二审：本该沉默的轮次重写出来仍是不该发的插话。
    expect(replyRepairAgent.repair).not.toHaveBeenCalled();
    expect(outputGuard.check).toHaveBeenCalledTimes(1);
    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(
      expect.objectContaining({
        ruleIds: ['meta_narration_reply'],
        reasonCode: 'meta_narration_silenced',
        ruleBlocked: true,
      }),
    );
    // 等效 skip_reply 的安静静默：不派 general_handoff（那会暂停托管+飞书告警，
    // 而该场景多为真人经理已在沟通，用户裁定真人插话不自动暂停）。
    expect(outcome.sideEffects ?? []).toEqual([]);
    // 守卫档案照常落库，观测不丢。
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        finalDecision: 'block',
        reasonCode: 'meta_narration_silenced',
        repaired: false,
      }),
    );
  });

  it('output guard block stays blocked when the rewrite still violates guardrails', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '不要新疆户籍的' }));
    replyRepairAgent.repair.mockResolvedValueOnce('还是不要新疆户籍的');
    outputGuard.check.mockResolvedValue({
      decision: 'block',
      riskLevel: 'high',
      violations: [
        {
          type: 'discriminatory_screening_leak',
          evidence: '命中高敏感规则',
          suggestion: '删除敏感条件',
          recoverability: 'non_recoverable',
          repairMode: 'rewrite',
        },
      ],
      ruleIds: ['discriminatory_screening_leak'],
      blockedRuleIds: ['discriminatory_screening_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有什么岗位' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(
      expect.objectContaining({
        ruleIds: ['discriminatory_screening_leak'],
        reasonCode: 'repair_exhausted',
        ruleBlocked: true,
        inspectedText: '还是不要新疆户籍的',
      }),
    );
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        alertLabel: '出站守卫拦截（rule 档）',
        reasonCode: 'system_blocked',
        recordHandoff: true,
      }),
    ]);
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    // 观测 P1-2：repair 终局事件——此前 repair_exhausted 只有 logger.warn
    expect(tracer.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'guardrail_repair',
        outcome: 'repair_exhausted',
        finalDecision: 'block',
        firstRuleIds: ['discriminatory_screening_leak'],
      }),
    );
  });

  it('output guard revise triggers one rewrite with reviseFeedback, then adopts revised reply', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '原始回复（语气僵硬）' }));
    replyRepairContextProvider.build.mockResolvedValueOnce({
      recentMessages: [{ role: 'user', content: '你好' }],
      factLines: ['城市：上海'],
      invitedGroups: [
        { groupName: '上海餐饮兼职群', city: '上海', industry: '餐饮', invitedAt: 't' },
      ],
      groupInventory: { city: '上海', hasAnyGroup: true, lines: ['- 餐饮：1 个群（均有空位）'] },
      presentedJobs: [],
      candidatePool: [],
      sessionFacts: null,
      profileFacts: null,
      longTermPreferences: null,
    });
    replyRepairAgent.repair.mockResolvedValueOnce('重写后的自然回复');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'medium',
        violations: [{ type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' }],
        ruleIds: [],
        blockedRuleIds: [],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '你好' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('重写后的自然回复');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair).toHaveBeenCalledWith(
      expect.objectContaining({
        userMessage: '你好',
        violations: [{ type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' }],
        repairContext: expect.objectContaining({
          factLines: ['城市：上海'],
          groupInventory: expect.objectContaining({ city: '上海' }),
        }),
      }),
    );
    expect(replyRepairContextProvider.build).toHaveBeenCalledWith({
      corpId: 'c1',
      userId: 'u1',
      sessionId: 's1',
      currentUserMessage: '你好',
      shortTermEndTimeInclusive: undefined,
    });
    expect(replyRepairAgent.repair.mock.calls[0][0]).toMatchObject({
      originalReply: '原始回复（语气僵硬）',
      ruleIds: [],
    });
  });

  it('recoverable rule veto repairs with no tools, then adopts the safe reply', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '这个岗位不要某地户籍，你报不了' }));
    replyRepairAgent.repair.mockResolvedValueOnce(
      '我先帮你看看更合适的岗位，需要同事确认后再回复你。',
    );
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'high',
        violations: [
          {
            type: 'discriminatory_screening_leak',
            evidence: '命中高敏感出站规则，证据已脱敏',
            suggestion: '不要提及户籍、籍贯、民族等门槛，改为中性承接。',
            severity: 'P0',
            dataSensitivity: 'high',
            recoverability: 'recoverable',
            currentReplySendable: false,
            feedbackPolicy: 'redacted',
            repairMode: 'rewrite',
          },
        ],
        ruleIds: ['discriminatory_screening_leak'],
        blockedRuleIds: ['discriminatory_screening_leak'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '我能报名吗' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('更合适');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair.mock.calls[0][0]).toMatchObject({
      originalReply: '这个岗位不要某地户籍，你报不了',
      ruleIds: ['discriminatory_screening_leak'],
    });
    expect(replyRepairAgent.repair.mock.calls[0][0].violations[0]).toMatchObject({
      type: 'discriminatory_screening_leak',
      feedbackPolicy: 'redacted',
      repairMode: 'rewrite',
    });
  });

  // 2026-07-27 replan 退役（评估文档 §2.4）：以下四条原为 replan 流程测试，改写为
  // "遗留 replan 裁决统一走 ReplyRepairAgent 受约束重写"的新契约——generator 只被
  // 调用一次（首版），修复不再重进 generator、不再持有任何工具白名单。

  it('repairs a legacy replan decision via ReplyRepairAgent without re-invoking the generator', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '推荐静安门店，距离 1.2km' }));
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'replan',
        riskLevel: 'medium',
        violations: [
          {
            type: 'job_recommendation_not_best_supported',
            evidence: '未接地岗位事实',
            suggestion: '只能按已有事实修正表述，或先中性追问。',
            severity: 'P1',
            recoverability: 'recoverable',
            currentReplySendable: false,
            repairMode: 'replan',
          },
        ],
        ruleIds: [],
        blockedRuleIds: ['job_recommendation_not_best_supported'],
        repairMode: 'replan',
        repairToolNames: ['geocode', 'duliday_job_list'],
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '附近有什么岗位' },
    });

    expect(outcome.kind).toBe('reply');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair.mock.calls[0][0]).toMatchObject({
      originalReply: '推荐静安门店，距离 1.2km',
    });
  });

  it('does not fail open a P0 violation when the rewrite repair stays in violation', async () => {
    generator.invoke.mockResolvedValueOnce(
      makeResult({
        text: '为了通过审核，我先帮你按社会人士登记。',
        toolCalls: [],
      }),
    );
    const p0Violation = {
      type: 'identity_misregistration_coaching',
      evidence: '教唆以不实身份登记',
      suggestion: '删除不实身份登记建议',
      severity: 'P0',
      recoverability: 'recoverable',
      currentReplySendable: false,
      repairMode: 'rewrite',
    };
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'high',
        violations: [p0Violation],
        ruleIds: ['identity_misregistration_coaching'],
        blockedRuleIds: ['identity_misregistration_coaching'],
        repairMode: 'rewrite',
        repairToolNames: [],
      })
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'high',
        violations: [p0Violation],
        ruleIds: ['identity_misregistration_coaching'],
        blockedRuleIds: ['identity_misregistration_coaching'],
        repairMode: 'rewrite',
        repairToolNames: [],
      });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '专业：医学' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.reply).toBeUndefined();
  });

  it('never grants business tool access to output repair even if a decision carries legacy tool fields', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '图片里是健康证，可以继续报名。' }));
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'replan',
        riskLevel: 'medium',
        violations: [
          {
            type: 'booking_receipt_mismatch',
            evidence: '预约回执不一致',
            suggestion: '按已确认回执修正表述',
            severity: 'P1',
            recoverability: 'recoverable',
            currentReplySendable: false,
            repairMode: 'replan',
          },
        ],
        ruleIds: ['booking_receipt_mismatch'],
        blockedRuleIds: ['booking_receipt_mismatch'],
        repairMode: 'replan',
        repairToolNames: ['save_image_description'],
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '[图片 messageId=img-1]' },
      context: { imageMessageIds: ['img-1'] },
    });

    expect(outcome.kind).toBe('reply');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair).toHaveBeenCalledTimes(1);
  });

  it('keeps draft side-effect toolCalls when reviewing and returning a revised reply', async () => {
    const bookingCall = {
      toolName: 'duliday_interview_booking',
      args: { jobId: 123 },
      result: { success: true, workOrderId: 'wo-1' },
    };
    generator.invoke.mockResolvedValueOnce(
      makeResult({ text: '已经约好了，但话术需要修', toolCalls: [bookingCall] }),
    );
    replyRepairAgent.repair.mockResolvedValueOnce('已帮你约好面试，稍后按通知到店就行');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'medium',
        violations: [{ type: 'bad_tone', evidence: '需要修', suggestion: '改自然' }],
        ruleIds: [],
        blockedRuleIds: [],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '帮我约面试' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('已帮你约好面试，稍后按通知到店就行');
    expect(generator.invoke).toHaveBeenCalledTimes(1);
    expect(replyRepairAgent.repair.mock.calls[0][0]).toMatchObject({
      originalReply: '已经约好了，但话术需要修',
    });
    expect(replyRepairAgent.repair.mock.calls[0][0].committedSideEffects).toContain(
      'duliday_interview_booking',
    );
    expect(outputGuard.check.mock.calls[1][0].toolCalls).toEqual([bookingCall]);
    expect(outcome.toolCalls).toEqual([bookingCall]);
  });

  it('invokeReviewedTurn wraps runTurnEnd in an agent-layer finalizer', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    generator.invoke.mockResolvedValue(makeResult({ text: '可以的', runTurnEnd }));

    const result = await service.invokeReviewedTurn({
      invoke: {
        callerKind: CallerKind.WECOM,
        messages: [{ role: 'user', content: '你好' }],
        userId: 'u1',
        corpId: 'c1',
        sessionId: 's1',
      },
      review: { userMessage: '你好', chatId: 's1', userId: 'u1' },
      trigger: { kind: 'inbound', userMessage: '你好' },
      sessionRef,
      messageId: 'm1',
    });

    expect(result.outcome.kind).toBe('reply');
    expect(result.runTurnEnd).toBeUndefined();
    expect(result.outcome.runTurnEnd).toBeUndefined();
    result.turnFinalizer.settle({ delivered: false });
    await result.turnFinalizer.whenSettled();
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
  });

  describe('precheckInboundOutcome', () => {
    const riskInput = {
      corpId: 'c1',
      chatId: 's1',
      userId: 'u1',
      pauseTargetId: 's1',
      scanContent: '你们就是骗子',
    };

    it('hit maps to an inbound guardrail_blocked outcome carrying the risk attribution', async () => {
      inputGuard.evaluate.mockResolvedValue({
        decision: 'block',
        source: 'input_risk',
        disposition: 'side_effects',
        reasonCode: 'abuse',
        riskType: 'abuse',
        riskLabel: '辱骂',
        reason: '命中辱骂关键词',
        inspectedText: '你们就是骗子',
        sideEffects: [
          {
            kind: 'conversation_risk',
            source: 'regex_intercept',
            riskType: 'abuse',
            riskLabel: '辱骂',
            summary: '候选人消息命中高置信度风险关键词',
            reason: '命中辱骂关键词',
          },
        ],
      });

      const outcome = await service.precheckInboundOutcome(riskInput);

      expect(outcome).not.toBeNull();
      expect(outcome?.kind).toBe('guardrail_blocked');
      expect(outcome?.guardrail).toEqual({
        phase: 'inbound',
        source: 'input_guardrail',
        riskType: 'abuse',
        riskLabel: '辱骂',
        reason: '命中辱骂关键词',
        reasonCode: 'abuse',
        inspectedText: '你们就是骗子',
      });
      expect(outcome?.sideEffects).toEqual([
        expect.objectContaining({ kind: 'conversation_risk', source: 'regex_intercept' }),
      ]);
    });

    it('miss returns null so the channel keeps generating', async () => {
      inputGuard.evaluate.mockResolvedValue({ decision: 'pass' });

      const outcome = await service.precheckInboundOutcome(riskInput);

      expect(outcome).toBeNull();
    });
  });

  it('revise still failing after the hard cap collapses to outbound guardrail_blocked', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: 'v1' }));
    replyRepairAgent.repair.mockResolvedValueOnce('v2 仍有问题');
    const reviseDecision = {
      decision: 'revise' as const,
      riskLevel: 'high' as const,
      violations: [{ type: 'hallucinated_fact', evidence: 'x', suggestion: 'y' }],
      ruleIds: [],
      blockedRuleIds: [],
      repairMode: 'rewrite' as const,
    };
    outputGuard.check.mockResolvedValue(reviseDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '约面试' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(
      expect.objectContaining({
        phase: 'outbound',
        source: 'output_guardrail',
        reasonCode: 'repair_exhausted',
      }),
    );
    expect(generator.invoke).toHaveBeenCalledTimes(1); // hard cap 1, rewrite 不复用 generator
  });

  it('repair exhausted with the same recurring P1 violation fails open to the revised reply', async () => {
    // 2026-07-24 审计 P1-3：同一规则复燃时两版违规程度相同，而修复版还多消化了一次
    // 反馈与二审，默认胜出（旧策略投首版曾致更优修复被弃、洗身份文本实际投递）。
    generator.invoke.mockResolvedValueOnce(makeResult({ text: 'v1' }));
    replyRepairAgent.repair.mockResolvedValueOnce('v2 修复版（仍有 P1 残留）');
    const p1ReviseDecision = {
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: [
        {
          type: 'booking_receipt_mismatch',
          evidence: '预约回执不一致',
          suggestion: '按回执修正',
          recoverability: 'recoverable' as const,
        },
      ],
      ruleIds: ['booking_receipt_mismatch'],
      blockedRuleIds: ['booking_receipt_mismatch'],
      repairMode: 'rewrite' as const,
    };
    outputGuard.check.mockResolvedValue(p1ReviseDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '我在江宁区' },
      context: { messageId: 'msg-failopen' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('v2 修复版（仍有 P1 残留）');
    expect(generator.invoke).toHaveBeenCalledTimes(1); // hard cap 不变，rewrite 不复用 generator
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-failopen',
        repaired: true,
        revisedReply: 'v2 修复版（仍有 P1 残留）',
        finalDecision: 'pass',
        reasonCode: 'repair_exhausted_fail_open',
      }),
    );
  });

  it('repair exhausted falls back to the first reply when the revision introduces a new blocked rule', async () => {
    // 修复版引入首版没有的 blocked 规则 = 真变差，回退首版。
    generator.invoke.mockResolvedValueOnce(makeResult({ text: 'v1' }));
    replyRepairAgent.repair.mockResolvedValueOnce('v2 修复版（引入新违规）');
    const makeDecision = (blockedRuleIds: string[]) => ({
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: blockedRuleIds.map((ruleId) => ({
        type: ruleId,
        evidence: '证据',
        suggestion: '修复建议',
        recoverability: 'recoverable' as const,
      })),
      ruleIds: blockedRuleIds,
      blockedRuleIds,
      repairMode: 'rewrite' as const,
    });
    outputGuard.check
      .mockResolvedValueOnce(makeDecision(['booking_receipt_mismatch']))
      .mockResolvedValueOnce(makeDecision(['brand_alias_fuzzy_match_ignored']));

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '我在江宁区' },
      context: { messageId: 'msg-failopen-worse' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('v1');
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-failopen-worse',
        repaired: true,
        reasonCode: 'repair_exhausted_fail_open',
      }),
    );
  });

  it('reverts a second-review-passing repair that collapses structured content (regression gate)', async () => {
    // 2026-07-24 审计 P1-5：二审只判"是否违规"不判"是否退步"——结构压扁的修复版
    // 曾带着二审 pass 直接投递（trace batch_6a609570…）。回归闸门在 pass 分支也生效。
    const firstReply = [
      '要帮你登记预约的话，先把下面资料发我：',
      '姓名：',
      '联系电话：',
      '性别：',
      '年龄：',
      '面试时间：（比如 明天下午 2 点）',
      '应聘门店：上海佘山旭辉里店',
      '学历：',
      '健康证：（有/无）',
      '身份：（学生/社会人士）',
      '应聘岗位：洗碗工',
    ].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: firstReply }));
    replyRepairAgent.repair.mockResolvedValueOnce('你看方便的话，发下姓名、电话和年龄就行。');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise' as const,
        riskLevel: 'medium' as const,
        violations: [
          {
            type: 'booking_receipt_mismatch',
            evidence: '预约回执不一致',
            suggestion: '按回执修正后回答',
            recoverability: 'recoverable' as const,
            // 生产上 revise 档一律派生 currentReplySendable=false（deriveRulePolicy）；
            // mock 保持同形态，防止"用该字段判定禁回退"的恒真条件回潮（2026-07-29）。
            currentReplySendable: false,
          },
        ],
        ruleIds: ['booking_receipt_mismatch'],
        blockedRuleIds: ['booking_receipt_mismatch'],
        repairMode: 'rewrite' as const,
      })
      .mockResolvedValueOnce({
        decision: 'pass' as const,
        riskLevel: 'low' as const,
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
        repairMode: 'rewrite' as const,
      });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '怎么报名' },
      context: { messageId: 'msg-regression' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(firstReply);
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-regression',
        repaired: true,
        reasonCode: 'repair_regression_reverted:structure_collapsed',
      }),
    );
  });

  it('blocks both versions when a regressed repair follows a non-fail-open first reply', async () => {
    // 对齐 guardrail-chain-assessment-and-rebuild.md §2.3 ④：检出回归时 P1/P2 回退首版、
    // P0 两版都不投。首版是红线内容时，回退等于把守卫已否决的文本重新投递。
    // 注意首版规则须取豁免集之外的不可恢复规则：internal_output_leak 等"首版即
    // 违规结构"的规则已豁免 structure_collapsed（2026-08-27 生产案 batch_6a8faabb…）。
    const firstReply = [
      '要帮你登记预约的话，先把下面资料发我：',
      '姓名：',
      '联系电话：',
      '性别：',
      '年龄：',
      '面试时间：',
      '应聘门店：上海佘山旭辉里店',
    ].join('\n');
    generator.invoke.mockResolvedValueOnce(makeResult({ text: firstReply }));
    replyRepairAgent.repair.mockResolvedValueOnce('你把姓名和电话发我就行。');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise' as const,
        riskLevel: 'medium' as const,
        violations: [
          {
            type: 'discriminatory_screening_leak',
            evidence: '外发了歧视性筛选条件',
            suggestion: '删除歧视性内容',
            recoverability: 'non_recoverable' as const,
            currentReplySendable: false,
          },
        ],
        ruleIds: ['discriminatory_screening_leak'],
        blockedRuleIds: ['discriminatory_screening_leak'],
        repairMode: 'rewrite' as const,
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '怎么报名' },
      context: { messageId: 'msg-non-sendable-regression' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.reply).toBeUndefined();
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-non-sendable-regression',
        repaired: true,
        finalDecision: 'block',
        reasonCode: 'repair_regression_blocked:structure_collapsed',
      }),
    );
  });

  it('delivers a passing rewrite of a leaked internal analysis without tripping the structure gate', async () => {
    // 2026-08-27 生产案 batch_6a8faabb…：首版把内部分析当回复输出（internal_output_leak
    // 正确 block），repair 重写合格且二审 pass，却被 structure_collapsed 判退化、两版
    // 都不投——候选人整轮静默。首版即违规结构时豁免结构坍缩，修复版应正常投递。
    const leakedAnalysis = [
      '根据查询结果，我来分析一下符合候选人要求的岗位：',
      '**候选人要求：**',
      '- 白天上班',
      '- 税前6000以上',
      '**筛选结果：**',
      '1. **通岗店员**：4000-5500元/月，每周6天 - 薪资不够6000',
      '2. **分拣打包**：6200-9800元/月，每周6天 - 薪资符合6000+',
      '但queryMeta.scheduleFilter显示excludedCount=0，说明没有岗位被剔除。',
    ].join('\n');
    const goodRepair = '我帮你查了下，符合的只有奥乐齐分拣打包，6200-9800元/月，但要每周上6天。';
    generator.invoke.mockResolvedValueOnce(makeResult({ text: leakedAnalysis }));
    replyRepairAgent.repair.mockResolvedValueOnce(goodRepair);
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise' as const,
        riskLevel: 'high' as const,
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '泄漏内部实现',
            suggestion: '只输出候选人可见回复',
            recoverability: 'non_recoverable' as const,
            currentReplySendable: false,
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite' as const,
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有没有白天班' },
      context: { messageId: 'msg-leak-rewrite-delivered' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe(goodRepair);
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-leak-rewrite-delivered',
        repaired: true,
        finalDecision: 'pass',
      }),
    );
  });

  it('repair exhausted with a non-recoverable violation still blocks even at medium risk', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: 'v1' }));
    replyRepairAgent.repair.mockResolvedValueOnce('v2 仍有问题');
    outputGuard.check.mockResolvedValue({
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: [
        {
          type: 'internal_output_leak',
          evidence: '泄漏内部实现',
          suggestion: '删除内部内容',
          recoverability: 'non_recoverable' as const,
        },
      ],
      ruleIds: ['internal_output_leak'],
      blockedRuleIds: ['internal_output_leak'],
      repairMode: 'rewrite' as const,
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '约面试' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(expect.objectContaining({ reasonCode: 'repair_exhausted' }));
  });

  it('dangling repair reply ("我帮你查下X") fails open to the first reply for recoverable P1 violations', async () => {
    // repair 模型无视重写指令、重新规划任务时只会产出一句悬空承接句——
    // rewrite 模式下工具已被移除，该承诺永远不会兑现，不能投递。
    generator.invoke.mockResolvedValueOnce(
      makeResult({ text: '花桥附近没岗哈，我拉你进餐饮兼职群' }),
    );
    replyRepairAgent.repair.mockResolvedValueOnce('我帮你查下花桥中骏附近的岗位');
    outputGuard.check.mockResolvedValueOnce({
      decision: 'revise',
      riskLevel: 'medium',
      violations: [
        {
          type: 'group_promise_without_invite',
          evidence: '承诺拉群未调用',
          suggestion: '删除拉群承诺',
        },
      ],
      ruleIds: ['group_promise_without_invite'],
      blockedRuleIds: ['group_promise_without_invite'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '花桥中骏有岗位吗' },
      context: { messageId: 'msg-dangling' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('花桥附近没岗哈，我拉你进餐饮兼职群');
    // 悬空产物不送二审（二审只查规则违规，会误放行）
    expect(outputGuard.check).toHaveBeenCalledTimes(1);
    // 审查档案落库，留存悬空文本供观测
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-dangling',
        repaired: true,
        revisedReply: '我帮你查下花桥中骏附近的岗位',
        finalDecision: 'pass',
        reasonCode: 'repair_unusable_fail_open',
      }),
    );
  });

  it('dangling repair reply still blocks when the first violation is high risk', async () => {
    generator.invoke.mockResolvedValueOnce(makeResult({ text: '这个岗位不要某地户籍' }));
    replyRepairAgent.repair.mockResolvedValueOnce('我帮你查下其他岗位');
    outputGuard.check.mockResolvedValueOnce({
      decision: 'revise',
      riskLevel: 'high',
      violations: [
        {
          type: 'discriminatory_screening_leak',
          evidence: '命中高敏感规则',
          suggestion: '删除敏感条件',
          recoverability: 'recoverable',
        },
      ],
      ruleIds: ['discriminatory_screening_leak'],
      blockedRuleIds: ['discriminatory_screening_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '我能报名吗' },
      context: { messageId: 'msg-high-dangling' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(expect.objectContaining({ reasonCode: 'revise_dangling' }));
  });

  it('repair-created internal_output_leak block fails open to the first reply for recoverable P1 violations', async () => {
    generator.invoke.mockResolvedValueOnce(
      makeResult({ text: '这边暂无合适岗位，我先帮你拉进兼职群。' }),
    );
    replyRepairAgent.repair.mockResolvedValueOnce('geocode(address="花桥")');
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'revise',
        riskLevel: 'medium',
        violations: [
          {
            type: 'group_promise_without_invite',
            evidence: '未调用拉群却承诺拉群',
            suggestion: '删除拉群承诺',
            recoverability: 'recoverable',
          },
        ],
        ruleIds: ['group_promise_without_invite'],
        blockedRuleIds: ['group_promise_without_invite'],
        repairMode: 'rewrite',
      })
      .mockResolvedValueOnce({
        decision: 'block',
        riskLevel: 'high',
        violations: [
          {
            type: 'internal_output_leak',
            evidence: '工具调用文本',
            suggestion: '删除内部输出',
            recoverability: 'non_recoverable',
          },
        ],
        ruleIds: ['internal_output_leak'],
        blockedRuleIds: ['internal_output_leak'],
        repairMode: 'rewrite',
      });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '松江这边有吗' },
      context: { messageId: 'msg-leak-failopen' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('这边暂无合适岗位，我先帮你拉进兼职群。');
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-leak-failopen',
        repaired: true,
        revisedReply: 'geocode(address="花桥")',
        finalDecision: 'pass',
        reasonCode: 'repair_unusable_fail_open',
      }),
    );
  });

  describe('guardrail review record persistence (guardrail_review_records)', () => {
    const reviseDecision = {
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: [{ type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' }],
      ruleIds: ['booking_receipt_mismatch'],
      blockedRuleIds: ['booking_receipt_mismatch'],
      repairMode: 'rewrite' as const,
      feedbackToGenerator: '不要给区级距离结论',
    };

    it('persists an off override hit with its marker even when the effective decision is pass', async () => {
      generator.invoke.mockResolvedValueOnce(
        makeResult({
          text: '[引用 候选人：现在还能报吗]\n名额放心，我帮你留着。\n[图片消息]\n[消息发送时间：2026-08-13 16:18:00]',
        }),
      );
      outputGuard.check.mockResolvedValueOnce({
        ...passDecision,
        overrideMarkers: ['override:off:quota_promise'],
      });

      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: '现在还能报吗' },
        context: { messageId: 'msg-hard-rule-override' },
      });

      expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-hard-rule-override',
          finalDecision: 'pass',
          reasonCode: 'override:off:quota_promise',
        }),
      );
    });

    it('revise flow persists first draft full text, violations and revised reply', async () => {
      generator.invoke.mockResolvedValueOnce(makeResult({ text: '首版（含区级距离断言）' }));
      replyRepairAgent.repair.mockResolvedValueOnce('重写后的回复');
      outputGuard.check.mockResolvedValueOnce(reviseDecision).mockResolvedValueOnce(passDecision);

      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: '西城区' },
        context: { messageId: 'msg-1' },
      });

      expect(guardrailReviews.recordReview).toHaveBeenCalledTimes(1);
      expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-1',
          chatId: 's1',
          userMessage: '西城区',
          firstReply: '首版（含区级距离断言）',
          first: expect.objectContaining({
            decision: 'revise',
            ruleIds: ['booking_receipt_mismatch'],
            violations: reviseDecision.violations,
            feedback: '不要给区级距离结论',
          }),
          repaired: true,
          repairMode: 'rewrite',
          revisedReply: '重写后的回复',
          revised: expect.objectContaining({ decision: 'pass' }),
          finalDecision: 'pass',
        }),
      );
    });

    it('first-review block persists both first and rewritten replies when repair succeeds', async () => {
      generator.invoke.mockResolvedValueOnce(makeResult({ text: '违规首版' }));
      replyRepairAgent.repair.mockResolvedValueOnce('干净重写版');
      outputGuard.check
        .mockResolvedValueOnce({
          ...reviseDecision,
          decision: 'block' as const,
          riskLevel: 'high' as const,
        })
        .mockResolvedValueOnce(passDecision);

      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: 'hi' },
        context: { messageId: 'msg-2' },
      });

      expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-2',
          firstReply: '违规首版',
          repaired: true,
          revisedReply: '干净重写版',
          finalDecision: 'pass',
        }),
      );
    });

    it('clean pass does not persist; missing traceId (debug/test traffic) does not persist', async () => {
      // pass 且无 rule 命中：不写档案
      generator.invoke.mockResolvedValueOnce(makeResult({ text: '正常回复' }));
      outputGuard.check.mockResolvedValueOnce(passDecision);
      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: 'hi' },
        context: { messageId: 'msg-3' },
      });
      expect(guardrailReviews.recordReview).not.toHaveBeenCalled();

      // 守卫命中但无 traceId（debug-chat / test-suite）：不写档案
      generator.invoke.mockResolvedValueOnce(makeResult({ text: '首版' }));
      replyRepairAgent.repair.mockResolvedValueOnce('重写版');
      outputGuard.check.mockResolvedValueOnce(reviseDecision).mockResolvedValueOnce(passDecision);
      await service.runTurn({ sessionRef, trigger: { kind: 'inbound', userMessage: 'hi' } });
      expect(guardrailReviews.recordReview).not.toHaveBeenCalled();
    });

    it('repair exhausted persists both steps with the collapsed block verdict (P0 高风险不 fail-open)', async () => {
      generator.invoke.mockResolvedValueOnce(makeResult({ text: 'v1' }));
      replyRepairAgent.repair.mockResolvedValueOnce('v2 仍有问题');
      outputGuard.check.mockResolvedValue({ ...reviseDecision, riskLevel: 'high' as const });

      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: '约面试' },
        context: { messageId: 'msg-4' },
      });

      expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-4',
          firstReply: 'v1',
          repaired: true,
          revisedReply: 'v2 仍有问题',
          revised: expect.objectContaining({ decision: 'revise' }),
          finalDecision: 'block',
          reasonCode: 'repair_exhausted',
        }),
      );
    });
  });
});
