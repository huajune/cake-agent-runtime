import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import type { GeneratorRunResult } from '@agent/generator/generator.types';
import { CallerKind } from '@enums/agent.enum';

describe('AgentRunnerService.runTurn', () => {
  let generator: { invoke: jest.Mock };
  let outputGuard: { check: jest.Mock };
  let inputGuard: { precheckInputRisk: jest.Mock; evaluate: jest.Mock };
  let guardrailReviews: { recordReview: jest.Mock };
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
    service = new AgentRunnerService(
      generator as never,
      outputGuard as never,
      inputGuard as never,
      guardrailReviews as never,
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
    expect(params.deferTurnEnd).toBe(true);
    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('考虑');
    expect(outcome.scenarioCode).toBe('opening_no_reply');
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

  it('output guard block maps to outbound guardrail_blocked outcome (not delivered)', async () => {
    generator.invoke.mockResolvedValue(makeResult({ text: '不要新疆户籍的' }));
    outputGuard.check.mockResolvedValue({
      decision: 'block',
      riskLevel: 'high',
      violations: [],
      ruleIds: ['discriminatory_screening_leak'],
      blockedRuleIds: ['discriminatory_screening_leak'],
      repairMode: 'rewrite',
    });

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '有什么岗位' },
    });

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual({
      phase: 'outbound',
      source: 'output_guardrail',
      ruleIds: ['discriminatory_screening_leak'],
      reasonCode: undefined,
      ruleBlocked: true,
      inspectedText: '不要新疆户籍的',
    });
    expect(outcome.sideEffects).toEqual([
      expect.objectContaining({
        kind: 'general_handoff',
        alertLabel: '出站守卫拦截（rule 档）',
        reasonCode: 'system_blocked',
        recordHandoff: true,
      }),
    ]);
    expect(generator.invoke).toHaveBeenCalledTimes(1); // 无重写
  });

  it('output guard revise triggers one rewrite with reviseFeedback, then adopts revised reply', async () => {
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: '原始回复（语气僵硬）' }))
      .mockResolvedValueOnce(makeResult({ text: '重写后的自然回复' }));
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
    expect(generator.invoke).toHaveBeenCalledTimes(2);
    const revisePass = generator.invoke.mock.calls[1][0];
    expect(revisePass.toolMode).toBe('none');
    expect(revisePass.guardrailRepair).toMatchObject({
      originalReply: '原始回复（语气僵硬）',
      ruleIds: [],
    });
    expect(revisePass.reviseFeedback).toEqual([
      { type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' },
    ]);
  });

  it('recoverable rule veto repairs with no tools, then adopts the safe reply', async () => {
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: '这个岗位不要某地户籍，你报不了' }))
      .mockResolvedValueOnce(
        makeResult({ text: '我先帮你看看更合适的岗位，需要同事确认后再回复你。' }),
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
    expect(generator.invoke).toHaveBeenCalledTimes(2);
    expect(generator.invoke.mock.calls[1][0].toolMode).toBe('none');
    expect(generator.invoke.mock.calls[1][0].guardrailRepair).toMatchObject({
      originalReply: '这个岗位不要某地户籍，你报不了',
      ruleIds: ['discriminatory_screening_leak'],
    });
    expect(generator.invoke.mock.calls[1][0].reviseFeedback[0]).toMatchObject({
      type: 'discriminatory_screening_leak',
      feedbackPolicy: 'redacted',
      repairMode: 'rewrite',
    });
  });

  it('recoverable replan guard lets the repair pass use readonly tools', async () => {
    const readonlyLookup = {
      toolName: 'duliday_job_list',
      args: { city: '上海' },
      result: { jobs: [{ storeName: '静安门店', distanceKm: 1.2 }] },
    };
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: '推荐静安门店，距离 1.2km' }))
      .mockResolvedValueOnce(
        makeResult({ text: '这边重新查到静安门店，距离约 1.2km。', toolCalls: [readonlyLookup] }),
      );
    outputGuard.check
      .mockResolvedValueOnce({
        decision: 'replan',
        riskLevel: 'medium',
        violations: [
          {
            type: 'ungrounded_job_recommendation',
            evidence: '未接地岗位事实',
            suggestion: '只能用只读工具重新查岗，或先中性追问。',
            severity: 'P1',
            recoverability: 'recoverable',
            currentReplySendable: false,
            repairMode: 'replan',
          },
        ],
        ruleIds: ['ungrounded_job_recommendation'],
        blockedRuleIds: ['ungrounded_job_recommendation'],
        repairMode: 'replan',
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '附近有什么岗位' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toContain('重新查到');
    expect(generator.invoke).toHaveBeenCalledTimes(2);
    expect(generator.invoke.mock.calls[1][0].toolMode).toBe('readonly');
    expect(generator.invoke.mock.calls[1][0].reviseFeedback[0]).toMatchObject({
      type: 'ungrounded_job_recommendation',
      repairMode: 'replan',
    });
  });

  it('keeps draft side-effect toolCalls when reviewing and returning a revised reply', async () => {
    const bookingCall = {
      toolName: 'duliday_interview_booking',
      args: { jobId: 123 },
      result: { success: true, workOrderId: 'wo-1' },
    };
    generator.invoke
      .mockResolvedValueOnce(
        makeResult({ text: '已经约好了，但话术需要修', toolCalls: [bookingCall] }),
      )
      .mockResolvedValueOnce(
        makeResult({ text: '已帮你约好面试，稍后按通知到店就行', toolCalls: [] }),
      );
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
    expect(generator.invoke.mock.calls[1][0].toolMode).toBe('none');
    expect(generator.invoke.mock.calls[1][0].guardrailRepair).toMatchObject({
      originalReply: '已经约好了，但话术需要修',
    });
    expect(generator.invoke.mock.calls[1][0].committedSideEffects).toContain(
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
        deferTurnEnd: true,
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
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: 'v1' }))
      .mockResolvedValueOnce(makeResult({ text: 'v2 仍有问题' }));
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
    expect(generator.invoke).toHaveBeenCalledTimes(2); // hard cap 1
  });

  it('repair exhausted with only recoverable P1 violations fails open and delivers the revised reply', async () => {
    // 2026-07-06 生产复盘：假阳 × repair_exhausted 静默是杀伤最大的组合。
    // 仅 P1/P2 可恢复违规时投递修复版（reasonCode 标注），只有 P0/不可恢复才保持静默。
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: 'v1' }))
      .mockResolvedValueOnce(makeResult({ text: 'v2 修复版（仍有 P1 残留）' }));
    const p1ReviseDecision = {
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: [
        {
          type: 'district_level_distance_claim',
          evidence: '区级位置报精确距离',
          suggestion: '不输出精确公里数',
          recoverability: 'recoverable' as const,
        },
      ],
      ruleIds: ['district_level_distance_claim'],
      blockedRuleIds: ['district_level_distance_claim'],
      repairMode: 'rewrite' as const,
    };
    outputGuard.check.mockResolvedValue(p1ReviseDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '我在江宁区' },
      context: { messageId: 'msg-failopen' },
    });

    expect(outcome.kind).toBe('reply');
    expect(generator.invoke).toHaveBeenCalledTimes(2); // hard cap 不变
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

  it('repair exhausted with a non-recoverable violation still blocks even at medium risk', async () => {
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: 'v1' }))
      .mockResolvedValueOnce(makeResult({ text: 'v2 仍有问题' }));
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

  it('dangling repair reply ("我帮你查下X") collapses to block instead of being delivered (badcase batch_6a4790c7)', async () => {
    // repair 模型无视重写指令、重新规划任务时只会产出一句悬空承接句——
    // rewrite 模式下工具已被移除，该承诺永远不会兑现，不能投递。
    generator.invoke
      .mockResolvedValueOnce(makeResult({ text: '花桥附近没岗哈，我拉你进餐饮兼职群' }))
      .mockResolvedValueOnce(makeResult({ text: '我帮你查下花桥中骏附近的岗位' }));
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

    expect(outcome.kind).toBe('guardrail_blocked');
    expect(outcome.guardrail).toEqual(
      expect.objectContaining({
        phase: 'outbound',
        source: 'output_guardrail',
        reasonCode: 'revise_dangling',
      }),
    );
    // 悬空产物不送二审（二审只查规则违规，会误放行）
    expect(outputGuard.check).toHaveBeenCalledTimes(1);
    // 审查档案落库，留存悬空文本供观测
    expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-dangling',
        repaired: true,
        revisedReply: '我帮你查下花桥中骏附近的岗位',
        finalDecision: 'block',
        reasonCode: 'revise_dangling',
      }),
    );
  });

  describe('guardrail review record persistence (guardrail_review_records)', () => {
    const reviseDecision = {
      decision: 'revise' as const,
      riskLevel: 'medium' as const,
      violations: [{ type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' }],
      ruleIds: ['district_level_distance_claim'],
      blockedRuleIds: ['district_level_distance_claim'],
      repairMode: 'rewrite' as const,
      feedbackToGenerator: '不要给区级距离结论',
    };

    it('revise flow persists first draft full text, violations and revised reply', async () => {
      generator.invoke
        .mockResolvedValueOnce(makeResult({ text: '首版（含区级距离断言）' }))
        .mockResolvedValueOnce(makeResult({ text: '重写后的回复' }));
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
            ruleIds: ['district_level_distance_claim'],
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

    it('first-review block (no repair) persists a first-only record', async () => {
      generator.invoke.mockResolvedValue(makeResult({ text: '违规首版' }));
      outputGuard.check.mockResolvedValue({
        ...reviseDecision,
        decision: 'block' as const,
      });

      await service.runTurn({
        sessionRef,
        trigger: { kind: 'inbound', userMessage: 'hi' },
        context: { messageId: 'msg-2' },
      });

      expect(guardrailReviews.recordReview).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-2',
          firstReply: '违规首版',
          repaired: false,
          finalDecision: 'block',
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
      generator.invoke
        .mockResolvedValueOnce(makeResult({ text: '首版' }))
        .mockResolvedValueOnce(makeResult({ text: '重写版' }));
      outputGuard.check.mockResolvedValueOnce(reviseDecision).mockResolvedValueOnce(passDecision);
      await service.runTurn({ sessionRef, trigger: { kind: 'inbound', userMessage: 'hi' } });
      expect(guardrailReviews.recordReview).not.toHaveBeenCalled();
    });

    it('repair exhausted persists both steps with the collapsed block verdict (P0 高风险不 fail-open)', async () => {
      generator.invoke
        .mockResolvedValueOnce(makeResult({ text: 'v1' }))
        .mockResolvedValueOnce(makeResult({ text: 'v2 仍有问题' }));
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
