import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import type { AgentRunResult as GeneratorRunResult } from '@agent/agent-run.types';

describe('AgentRunnerService.runTurn', () => {
  let generator: { invoke: jest.Mock };
  let outputGuard: { check: jest.Mock };
  let inputGuard: { evaluate: jest.Mock };
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
    inputGuard = { evaluate: jest.fn().mockResolvedValue({ decision: 'pass' }) };
    service = new AgentRunnerService(
      generator as never,
      outputGuard as never,
      inputGuard as never,
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

  it('request_handoff maps to handoff with alreadyDispatched=true', async () => {
    generator.invoke.mockResolvedValue(
      makeResult({
        text: '需要人工',
        toolCalls: [
          {
            toolName: 'request_handoff',
            args: { reasonCode: 'modify_appointment', reason: '冲突' },
            result: { dispatched: true, shortCircuited: true },
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
    expect(outcome.handoff?.alreadyDispatched).toBe(true);
    expect(outcome.handoff?.idempotencyKey).toBe('s1:handoff:m1');
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

  it('output guard block maps to blocked outcome (not delivered)', async () => {
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

    expect(outcome.kind).toBe('blocked');
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

  describe('precheckInboundOutcome', () => {
    const riskInput = {
      corpId: 'c1',
      chatId: 's1',
      userId: 'u1',
      pauseTargetId: 's1',
      scanContent: '你们就是骗子',
    };

    it('hit maps to an intercepted outcome carrying the risk attribution', async () => {
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
            currentMessageContent: '你们就是骗子',
          },
        ],
      });

      const outcome = await service.precheckInboundOutcome(riskInput);

      expect(outcome).not.toBeNull();
      expect(outcome?.kind).toBe('intercepted');
      expect(outcome?.intercept).toEqual({
        riskType: 'abuse',
        label: '辱骂',
        reason: '命中辱骂关键词',
      });
      // 守卫只声明副作用意图，执行由渠道经 TurnOutcomeInterventionService.commit 统一出口
      expect(outcome?.sideEffects).toHaveLength(1);
      expect(outcome?.sideEffects?.[0]).toMatchObject({ kind: 'conversation_risk', riskType: 'abuse' });
    });

    it('miss returns null so the channel keeps generating', async () => {
      inputGuard.evaluate.mockResolvedValue({ decision: 'pass' });

      const outcome = await service.precheckInboundOutcome(riskInput);

      expect(outcome).toBeNull();
    });
  });

  it('revise still failing after the hard cap collapses to blocked', async () => {
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

    expect(outcome.kind).toBe('blocked');
    expect(generator.invoke).toHaveBeenCalledTimes(2); // hard cap 1
  });
});
