import { FollowUpProcessor } from '@agent/reengagement/follow-up.processor';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/reengagement.types';
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

const makeJob = (over: Partial<Record<string, unknown>> = {}) =>
  ({
    id: 'job-1',
    data: {
      sessionRef,
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
      anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
    },
    ...over,
  }) as never;

describe('FollowUpProcessor', () => {
  let queue: { process: jest.Mock; add: jest.Mock };
  let session: { getAuthoritativeState: jest.Mock };
  let runner: { runTurn: jest.Mock };
  let touchLedger: {
    isOverFrequencyLimit: jest.Mock;
    reserve: jest.Mock;
    markDeliveryAttempted: jest.Mock;
    markSent: jest.Mock;
    markFailedOrUnknown: jest.Mock;
  };
  let systemConfig: { getAgentReplyConfig: jest.Mock };
  let outcomeFinalizer: { commit: jest.Mock };
  let tracking: Record<string, jest.Mock>;
  let delivery: { deliver: jest.Mock };

  beforeEach(() => {
    jest.useRealTimers();
    queue = { process: jest.fn(), add: jest.fn().mockResolvedValue(undefined) };
    session = { getAuthoritativeState: jest.fn().mockResolvedValue(baseState()) };
    runner = { runTurn: jest.fn() };
    touchLedger = {
      isOverFrequencyLimit: jest.fn().mockResolvedValue(false),
      reserve: jest.fn().mockResolvedValue('reserved'),
      markDeliveryAttempted: jest.fn().mockResolvedValue(undefined),
      markSent: jest.fn().mockResolvedValue(undefined),
      markFailedOrUnknown: jest.fn().mockResolvedValue(undefined),
    };
    systemConfig = {
      getAgentReplyConfig: jest
        .fn()
        .mockResolvedValue({ reengagementEnabled: true, reengagementShadow: true }),
    };
    outcomeFinalizer = { commit: jest.fn().mockResolvedValue(undefined) };
    tracking = {
      trackDisabledAtFire: jest.fn(),
      trackStopped: jest.fn(),
      trackFrequencyBlocked: jest.fn(),
      trackRescheduled: jest.fn(),
      trackShadow: jest.fn(),
      trackDuplicate: jest.fn(),
      trackReserved: jest.fn(),
      trackOutcomeNotReply: jest.fn(),
      trackDeliveryAttempted: jest.fn(),
      trackSent: jest.fn(),
      trackDeliveryUnknown: jest.fn(),
    };
    delivery = { deliver: jest.fn().mockResolvedValue(undefined) };
  });

  const buildProcessor = (withDelivery = true) =>
    new FollowUpProcessor(
      queue as never,
      session as never,
      runner as never,
      touchLedger as never,
      systemConfig as never,
      outcomeFinalizer as never,
      tracking as never,
      withDelivery ? (delivery as never) : undefined,
    );

  it('registers the configured follow-up job name', () => {
    buildProcessor().onModuleInit();

    expect(queue.process).toHaveBeenCalledWith(REENGAGEMENT_JOB_NAME, 2, expect.any(Function));
  });

  it('drops in-flight jobs without generating when the master switch is off', async () => {
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: false,
      reengagementShadow: true,
    });

    await buildProcessor().process(makeJob());

    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('shadows with rollout_disabled when the scenario is switched off in runtime config', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还在考虑吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
      reengagementScenarioRollout: { opening_no_reply: false },
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(tracking.trackShadow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'rollout_disabled' }),
    );
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
  });

  it('shadows post-booking scenarios when the post-booking master switch is off', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '面试提醒' },
      toolCalls: [],
      scenarioCode: 'interview_reminder',
      runTurnEnd,
    });
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
      reengagementPostBookingEnabled: false,
    });

    await buildProcessor().process(
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'evt-1',
          anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
        },
      }),
    );

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(tracking.trackShadow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'rollout_disabled' }),
    );
  });

  it('runs turn-end with includeAssistantText=false in shadow mode without delivering', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还在考虑吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: true,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
  });

  it('runs turn-end without assistant projection for skipped shadow outcomes', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    runner.runTurn.mockResolvedValue({
      kind: 'skipped',
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
  });

  it('delivers non-shadow replies through the outbox and then runs turn-end lifecycle', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.reserve).toHaveBeenCalledWith('sess-1:opening_no_reply:1782266400000');
    expect(touchLedger.markDeliveryAttempted).toHaveBeenCalled();
    expect(delivery.deliver).toHaveBeenCalledWith(expect.objectContaining({ kind: 'reply' }), {
      idempotencyKey: 'sess-1:opening_no_reply:1782266400000',
    });
    expect(touchLedger.markSent).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'sess-1',
      now,
    );
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: true });
  });

  it('commits side effects for non-shadow non-reply outcomes before marking the touch failed', async () => {
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    const sideEffect = {
      kind: 'general_handoff',
      source: 'agent_tool',
      alertLabel: '出站守卫拦截（rule 档）',
      reasonCode: 'system_blocked',
      reason: '出站守卫拦截',
      recordHandoff: true,
    };
    const outcome = {
      kind: 'guardrail_blocked',
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      disposition: 'side_effects',
      sideEffects: [sideEffect],
      guardrail: { phase: 'outbound', source: 'output_guardrail' },
    };
    runner.runTurn.mockResolvedValue(outcome);

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(outcomeFinalizer.commit).toHaveBeenCalledWith(
      outcome,
      expect.objectContaining({
        traceId: 'sess-1:opening_no_reply:1782266400000',
        chatId: 'sess-1',
        userId: 'user-1',
        corpId: 'corp-1',
        userMessage: '[系统主动跟进:opening_no_reply]',
      }),
    );
    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'failed',
    );
    expect(outcomeFinalizer.commit.mock.invocationCallOrder[0]).toBeLessThan(
      touchLedger.markFailedOrUnknown.mock.invocationCallOrder[0],
    );
  });

  it('keeps a sent touch sent when turn-end lifecycle fails after delivery', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const runTurnEnd = jest.fn().mockRejectedValue(new Error('memory down'));
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).toHaveBeenCalled();
    expect(touchLedger.markSent).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'sess-1',
      now,
    );
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: true });
    expect(touchLedger.markFailedOrUnknown).not.toHaveBeenCalled();
  });

  it('does not generate or deliver duplicate inflight slots', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    touchLedger.reserve.mockResolvedValue('duplicate_inflight');
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.markDeliveryAttempted).not.toHaveBeenCalled();
    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).not.toHaveBeenCalled();
  });

  it('does not generate or run turn-end when a duplicate sent slot is skipped', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    touchLedger.reserve.mockResolvedValue('duplicate_sent');
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(runTurnEnd).not.toHaveBeenCalled();
  });

  it('runs turn-end without assistant projection when delivery fails and marks the touch unknown', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    const error = new Error('delivery down');
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    delivery.deliver.mockRejectedValue(error);
    runner.runTurn.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await expect(buildProcessor().process(makeJob())).rejects.toThrow('delivery down');

    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:1782266400000',
      'unknown',
    );
    // 送达与否未知按未送达处理（HC-4）：仍完成用户侧记忆收尾，但不投影助手轮次。
    expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
  });

  it('reschedules directly to the next delivery window when fired outside the window', async () => {
    const now = Date.UTC(2026, 5, 24, 14, 0, 0); // 22:00 Shanghai
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await buildProcessor().process(makeJob({ id: 'late-job' }));

    const expectedFireAt = Date.UTC(2026, 5, 25, 1, 0, 0); // next day 09:00 Shanghai
    expect(runner.runTurn).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith(
      REENGAGEMENT_JOB_NAME,
      expect.objectContaining({ anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0) }),
      expect.objectContaining({
        jobId: `late-job:rw:${expectedFireAt}`,
        delay: expectedFireAt - now,
      }),
    );
    expect(tracking.trackRescheduled).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'sess-1', scenarioCode: 'opening_no_reply' }),
      expectedFireAt,
      `late-job:rw:${expectedFireAt}`,
    );
  });

  describe('二次触发追溯落库埋点', () => {
    const expectedIdentity = expect.objectContaining({
      sessionId: 'sess-1',
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
    });

    beforeEach(() => {
      // 前序用例可能把 Date.now mock 在 9-21 窗口外，先恢复再固定到窗口内（10:00 上海）
      jest.restoreAllMocks();
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 0, 0));
    });

    it('tracks disabled when the master switch is off at fire time', async () => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: false,
        reengagementShadow: true,
      });

      await buildProcessor().process(makeJob());

      expect(tracking.trackDisabledAtFire).toHaveBeenCalledWith(expectedIdentity);
    });

    it('tracks stopped with reason when stop condition hits', async () => {
      session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'booked' }));

      await buildProcessor().process(makeJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(expectedIdentity, 'terminal:booked');
      expect(runner.runTurn).not.toHaveBeenCalled();
    });

    it('tracks frequency block', async () => {
      touchLedger.isOverFrequencyLimit.mockResolvedValue(true);

      await buildProcessor().process(makeJob());

      expect(tracking.trackFrequencyBlocked).toHaveBeenCalledWith(expectedIdentity);
    });

    it('tracks shadow with generated text', async () => {
      runner.runTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: '还在考虑吗？' },
        toolCalls: [],
        scenarioCode: 'opening_no_reply',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });

      await buildProcessor().process(makeJob());

      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expectedIdentity,
        expect.objectContaining({
          outcomeKind: 'reply',
          generatedText: '还在考虑吗？',
          reason: 'shadow_mode',
        }),
      );
    });

    it('tracks reserved → attempted → sent along the real delivery path', async () => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
      });
      runner.runTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: '明天见！' },
        toolCalls: [],
        scenarioCode: 'opening_no_reply',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });

      await buildProcessor().process(makeJob());

      expect(tracking.trackReserved).toHaveBeenCalledWith(expectedIdentity);
      expect(tracking.trackDeliveryAttempted).toHaveBeenCalledWith(expectedIdentity);
      expect(tracking.trackSent).toHaveBeenCalledWith(expectedIdentity, '明天见！');
    });

    it('tracks unknown when delivery throws', async () => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
      });
      runner.runTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: 'hi' },
        toolCalls: [],
        scenarioCode: 'opening_no_reply',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });
      delivery.deliver.mockRejectedValue(new Error('gateway timeout'));

      await expect(buildProcessor().process(makeJob())).rejects.toThrow('gateway timeout');

      expect(tracking.trackDeliveryUnknown).toHaveBeenCalledWith(
        expectedIdentity,
        'gateway timeout',
      );
      expect(tracking.trackSent).not.toHaveBeenCalled();
    });

    it('tracks duplicate when the touch slot is already taken', async () => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
      });
      touchLedger.reserve.mockResolvedValue('duplicate_sent');

      await buildProcessor().process(makeJob());

      expect(tracking.trackDuplicate).toHaveBeenCalledWith(expectedIdentity, 'duplicate_sent');
      expect(runner.runTurn).not.toHaveBeenCalled();
    });
  });
});
