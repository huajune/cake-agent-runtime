import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import type { GeneratorRunResult } from '@agent/generator/generator.types';

describe('AgentRunnerService.runTurn', () => {
  let generator: { invoke: jest.Mock };
  let outputGuard: { check: jest.Mock };
  let inputRiskGuard: { precheck: jest.Mock };
  let service: AgentRunnerService;

  const passDecision = {
    decision: 'pass' as const,
    riskLevel: 'low' as const,
    violations: [],
    ruleIds: [],
    blockedRuleIds: [],
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
    inputRiskGuard = { precheck: jest.fn().mockResolvedValue({ hit: false }) };
    service = new AgentRunnerService(
      generator as never,
      outputGuard as never,
      inputRiskGuard as never,
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
    expect(revisePass.reviseFeedback).toEqual([
      { type: 'bad_tone', evidence: '僵硬', suggestion: '更自然' },
    ]);
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
      })
      .mockResolvedValueOnce(passDecision);

    const outcome = await service.runTurn({
      sessionRef,
      trigger: { kind: 'inbound', userMessage: '帮我约面试' },
    });

    expect(outcome.kind).toBe('reply');
    expect(outcome.reply?.text).toBe('已帮你约好面试，稍后按通知到店就行');
    expect(generator.invoke.mock.calls[1][0].toolMode).toBe('none');
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
      inputRiskGuard.precheck.mockResolvedValue({
        hit: true,
        riskType: 'abuse',
        label: '辱骂',
        reason: '命中辱骂关键词',
      });

      const outcome = await service.precheckInboundOutcome(riskInput);

      expect(outcome).not.toBeNull();
      expect(outcome?.kind).toBe('intercepted');
      expect(outcome?.intercept).toEqual({
        riskType: 'abuse',
        label: '辱骂',
        reason: '命中辱骂关键词',
      });
    });

    it('miss returns null so the channel keeps generating', async () => {
      inputRiskGuard.precheck.mockResolvedValue({ hit: false });

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
