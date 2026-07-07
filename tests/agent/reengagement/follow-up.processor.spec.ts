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
  let messageTracking: { recordProactiveTurn: jest.Mock };
  let sponge: { getCachedWorkOrderById: jest.Mock };
  let longTerm: { getActiveBookings: jest.Mock };
  let scheduler: { scheduleFollowUp: jest.Mock };
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
    sponge = { getCachedWorkOrderById: jest.fn().mockResolvedValue(null) };
    longTerm = { getActiveBookings: jest.fn().mockResolvedValue([]) };
    scheduler = { scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }) };
    tracking = {
      resolveChannelIdentity: jest.fn().mockResolvedValue(null),
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
    messageTracking = { recordProactiveTurn: jest.fn() };
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
      messageTracking as never,
      sponge as never,
      longTerm as never,
      scheduler as never,
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
      expect(tracking.trackSent).toHaveBeenCalledWith(
        expectedIdentity,
        '明天见！',
        expect.stringMatching(/^batch_sess-1_\d+$/),
      );
      // 投递成功的主动回合落一行消息处理流水（message_id = batchId）
      expect(messageTracking.recordProactiveTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'sess-1',
          status: 'success',
          replyPreview: '明天见！',
          messageId: expect.stringMatching(/^batch_sess-1_\d+$/),
          batchId: expect.stringMatching(/^batch_sess-1_\d+$/),
        }),
      );
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
        expect.stringMatching(/^batch_sess-1_\d+$/),
      );
      expect(tracking.trackSent).not.toHaveBeenCalled();
      // 投递状态不明也落流水（failure），排障时能看到该回合的完整生成轨迹
      expect(messageTracking.recordProactiveTurn).toHaveBeenCalledWith(
        expect.objectContaining({ chatId: 'sess-1', status: 'failure', error: 'gateway timeout' }),
      );
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

  describe('存量任务渠道身份兜底', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
      // 10:00 上海，投递窗口内
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 0, 0));
      runner.runTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: '还在考虑吗？' },
        toolCalls: [],
        scenarioCode: 'opening_no_reply',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });
    });

    it('resolves identity from chat history when the job payload has none', async () => {
      tracking.resolveChannelIdentity.mockResolvedValue({
        candidateName: '张三',
        managerName: 'bot-user-1',
        botImId: 'wxid-bot-1',
      });

      await buildProcessor().process(makeJob());

      expect(tracking.resolveChannelIdentity).toHaveBeenCalledWith('sess-1');
      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 'sess-1',
          candidateName: '张三',
          managerName: 'bot-user-1',
          botImId: 'wxid-bot-1',
        }),
        expect.anything(),
      );
    });

    it('skips the fallback lookup when the job payload already carries identity', async () => {
      await buildProcessor().process(
        makeJob({
          data: {
            sessionRef,
            scenarioCode: 'opening_no_reply',
            anchorEventId: 'evt-1',
            anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
            channelIdentity: { candidateName: '李四', managerName: 'bot-2', botImId: 'wxid-2' },
          },
        }),
      );

      expect(tracking.resolveChannelIdentity).not.toHaveBeenCalled();
      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expect.objectContaining({ candidateName: '李四' }),
        expect.anything(),
      );
    });

    it('still records the touch with null identity when the fallback lookup fails', async () => {
      tracking.resolveChannelIdentity.mockRejectedValue(new Error('db down'));

      await buildProcessor().process(makeJob());

      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'sess-1', scenarioCode: 'opening_no_reply' }),
        expect.anything(),
      );
      const identityArg = tracking.trackShadow.mock.calls[0][0] as Record<string, unknown>;
      expect(identityArg.candidateName).toBeUndefined();
      expect(identityArg.botImId).toBeUndefined();
    });
  });

  describe('报名后到点核验（外部取消/已面试/改期）', () => {
    const anchorAt = Date.UTC(2026, 5, 24, 2, 0, 0);
    // 期望面试时间：2026-06-25 14:00 Shanghai
    const expectedInterviewAt = Date.UTC(2026, 5, 25, 6, 0, 0);

    const bookingJob = (over: Partial<Record<string, unknown>> = {}) =>
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'evt-b',
          anchorAt,
          workOrderId: 555,
          expectedInterviewAt,
          ...over,
        },
      });

    beforeEach(() => {
      jest.restoreAllMocks();
      // 10:30 Shanghai，投递窗口内
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 30, 0));
      session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'booked' }));
      runner.runTurn.mockResolvedValue({
        kind: 'reply',
        reply: { text: '面试提醒' },
        toolCalls: [],
        scenarioCode: 'interview_reminder',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });
    });

    it('stops with external_cancelled when the work order was cancelled outside the chat', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面取消',
      });

      await buildProcessor().process(bookingJob());

      expect(sponge.getCachedWorkOrderById).toHaveBeenCalledWith(555);
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioCode: 'interview_reminder' }),
        'external_cancelled:约面取消',
      );
      expect(runner.runTurn).not.toHaveBeenCalled();
    });

    it('passes the per-bot token context to the sponge work-order lookup', async () => {
      // 多 bot 企业 per-bot token ≠ 全局 fallback，不带 botImId 查工单会静默 miss，
      // 外部取消检测整条失效（2026-07-06 review）
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面取消',
      });

      await buildProcessor().process(
        bookingJob({ channelIdentity: { botImId: 'bot-1', candidateName: '张三' } }),
      );

      expect(sponge.getCachedWorkOrderById).toHaveBeenCalledWith(555, { botImId: 'bot-1' });
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'external_cancelled:约面取消',
      );
    });

    it('stops the reminder when the interview already happened', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '面试成功',
      });

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'interview_already_done:面试成功',
      );
      expect(runner.runTurn).not.toHaveBeenCalled();
    });

    it('lets post_interview_followup proceed when the interview is done', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '面试成功',
      });

      await buildProcessor().process(bookingJob({ scenarioCode: 'post_interview_followup' }));

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(runner.runTurn).toHaveBeenCalled();
    });

    it('stops with interview_time_changed when active_booking carries a different time', async () => {
      // active_booking 已改到 16:00（聊天改约路径），旧任务停 + 按新时间补排替代任务
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 16:00' },
      ]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_changed',
      );
      expect(runner.runTurn).not.toHaveBeenCalled();
      // 替代任务锚点幂等（wo:iv:scenario）：与聊天改约锚点排的任务同 jobId，Bull 去重
      expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioCode: 'interview_reminder',
          anchorEventId: `wo555:iv${Date.UTC(2026, 5, 25, 8, 0, 0)}:interview_reminder`,
          workOrderId: 555,
          expectedInterviewAt: Date.UTC(2026, 5, 25, 8, 0, 0),
        }),
      );
    });

    it('detects backend time changes via the sponge interviewTime field', async () => {
      // 后台改时间：海绵 interviewTime 已变，本地 active_booking 还是旧时间——以海绵为准
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-25 16:00',
      });
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 14:00' },
      ]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_changed',
      );
      expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          anchorEventId: `wo555:iv${Date.UTC(2026, 5, 25, 8, 0, 0)}:interview_reminder`,
        }),
      );
    });

    it('trusts a matching sponge interviewTime over a stale local pointer', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-25 14:00',
      });
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 16:00' },
      ]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(runner.runTurn).toHaveBeenCalled();
    });

    it('does not schedule a reminder replacement when the new time is already past', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-20 10:00',
      });

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_changed',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
    });

    it('proceeds when active_booking time matches the frozen expectation', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 14:00' },
      ]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(runner.runTurn).toHaveBeenCalled();
    });

    it('fails open when neither sponge nor active_booking yields verification data', async () => {
      sponge.getCachedWorkOrderById.mockResolvedValue(null);
      longTerm.getActiveBookings.mockResolvedValue([]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(runner.runTurn).toHaveBeenCalled();
    });

    it('exempts verifiable booking follow-ups from the replied-after-anchor rule', async () => {
      session.getAuthoritativeState.mockResolvedValue(
        baseState({ terminal: 'booked', lastCandidateMessageAt: anchorAt + 1 }),
      );

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(runner.runTurn).toHaveBeenCalled();
    });

    it('keeps the replied-after-anchor rule for legacy jobs without workOrderId', async () => {
      session.getAuthoritativeState.mockResolvedValue(
        baseState({ terminal: 'booked', lastCandidateMessageAt: anchorAt + 1 }),
      );

      await buildProcessor().process(
        bookingJob({ workOrderId: undefined, expectedInterviewAt: undefined }),
      );

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'candidate_replied_after_anchor',
      );
      expect(runner.runTurn).not.toHaveBeenCalled();
    });
  });
});
