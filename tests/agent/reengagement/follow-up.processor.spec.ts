import { FollowUpProcessor } from '@agent/reengagement/follow-up.processor';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/follow-up-scheduler.service';
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

const asExecution = (outcome: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  outcome,
  agentRequest: { type: 'test-reengagement-agent' },
  aiStartAt: Date.UTC(2026, 5, 24, 2, 0, 0),
  aiEndAt: Date.UTC(2026, 5, 24, 2, 0, 1),
  ...over,
});

describe('FollowUpProcessor', () => {
  let queue: { process: jest.Mock; add: jest.Mock };
  let session: { getAuthoritativeState: jest.Mock };
  let reengagementAgent: { compose: jest.Mock };
  let touchLedger: {
    isOverFrequencyLimit: jest.Mock;
    isInSessionTouchCooldown: jest.Mock;
    reserve: jest.Mock;
    markDeliveryAttempted: jest.Mock;
    markSent: jest.Mock;
    markFailedOrUnknown: jest.Mock;
  };
  let systemConfig: { getAgentReplyConfig: jest.Mock };
  let tracking: Record<string, jest.Mock>;
  let messageTracking: { recordProactiveTurn: jest.Mock };
  let sponge: {
    getWorkOrderById: jest.Mock;
    fetchJobs: jest.Mock;
  };
  let longTerm: { getActiveBookings: jest.Mock };
  let scheduler: { scheduleFollowUp: jest.Mock };
  let configService: { get: jest.Mock };
  let delivery: { deliver: jest.Mock };

  beforeEach(() => {
    jest.useRealTimers();
    queue = { process: jest.fn(), add: jest.fn().mockResolvedValue(undefined) };
    session = { getAuthoritativeState: jest.fn().mockResolvedValue(baseState()) };
    reengagementAgent = {
      compose: jest.fn().mockResolvedValue(
        asExecution({
          kind: 'reply',
          reply: { text: '还在考虑吗？' },
          generatedText: '还在考虑吗？',
          toolCalls: [],
          scenarioCode: 'opening_no_reply',
          agentSteps: [],
        }),
      ),
    };
    touchLedger = {
      isOverFrequencyLimit: jest.fn().mockResolvedValue(false),
      isInSessionTouchCooldown: jest.fn().mockResolvedValue(false),
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
    const getWorkOrderById = jest.fn().mockResolvedValue(null);
    sponge = {
      getWorkOrderById,
      fetchJobs: jest.fn().mockResolvedValue({ jobs: [], total: 0 }),
    };
    longTerm = { getActiveBookings: jest.fn().mockResolvedValue([]) };
    scheduler = { scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }) };
    configService = {
      get: jest.fn((key: string) =>
        key === 'STRIDE_ENTERPRISE_TOKEN' ? 'stride-enterprise-token' : undefined,
      ),
    };
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
    delivery = {
      deliver: jest.fn().mockResolvedValue({
        success: true,
        segmentCount: 1,
        failedSegments: 0,
        deliveredSegments: 1,
        totalTime: 0,
      }),
    };
  });

  const buildProcessor = (withDelivery = true) =>
    new FollowUpProcessor(
      queue as never,
      session as never,
      reengagementAgent as never,
      touchLedger as never,
      systemConfig as never,
      tracking as never,
      messageTracking as never,
      sponge as never,
      longTerm as never,
      scheduler as never,
      configService as never,
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

    expect(reengagementAgent.compose).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('shadows with rollout_disabled when the scenario is switched off in runtime config', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    reengagementAgent.compose.mockResolvedValue({
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
  });

  it('shadows post-booking scenarios when the post-booking master switch is off', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 5, 0, 0));
    sponge.getWorkOrderById.mockResolvedValue({
      workOrderId: 555,
      currentStatus: '约面成功',
      interviewTime: '2026-06-24 14:00',
    });
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '面试提醒' },
      toolCalls: [],
      scenarioCode: 'interview_reminder',
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
          workOrderId: 555,
          expectedInterviewAt: Date.UTC(2026, 5, 24, 6, 0, 0),
        },
      }),
    );

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(tracking.trackShadow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reason: 'rollout_disabled' }),
    );
  });

  it('does not write assistant history in shadow mode without delivering', async () => {
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还在考虑吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
    });
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: true,
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not write assistant history for skipped shadow outcomes', async () => {
    reengagementAgent.compose.mockResolvedValue({
      kind: 'skipped',
      generatedText: '候选人不可见草稿',
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
    });

    await buildProcessor().process(makeJob());

    expect(tracking.trackShadow).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        outcomeKind: 'skipped',
        generatedText: '候选人不可见草稿',
      }),
    );
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('delivers non-shadow replies with a stable channel externalRequestId', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.reserve).toHaveBeenCalledWith('sess-1:opening_no_reply:evt-1');
    expect(touchLedger.markDeliveryAttempted).toHaveBeenCalled();
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'reply' }),
      expect.objectContaining({
        idempotencyKey: 'sess-1:opening_no_reply:evt-1',
        context: expect.objectContaining({
          token: 'stride-enterprise-token',
          _apiType: 'enterprise',
          chatId: 'sess-1',
          messageId: 'batch_sess-1_1782266400000',
          externalRequestId: 'batch_sess-1_1782266400000',
        }),
      }),
    );
    expect(touchLedger.markSent).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:evt-1',
      'sess-1',
      now,
    );
  });

  it('uses the enterprise token even when legacy payload carries a frozen token', async () => {
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });

    await buildProcessor().process(
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'evt-1',
          anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
          channelIdentity: {
            candidateName: '张三',
            botImId: 'bot-1',
            imContactId: 'contact-1',
            token: 'legacy-frozen-token',
            apiType: 'group',
          },
        },
      }),
    );

    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: expect.objectContaining({
          token: 'stride-enterprise-token',
          _apiType: 'enterprise',
        }),
      }),
    );
  });

  it('does not fall back to frozen callback token when STRIDE_ENTERPRISE_TOKEN is not configured', async () => {
    configService.get.mockReturnValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });

    await buildProcessor().process(
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'opening_no_reply',
          anchorEventId: 'evt-1',
          anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
          channelIdentity: {
            candidateName: '张三',
            botImId: 'bot-1',
            imContactId: 'contact-1',
            apiType: 'enterprise',
            token: 'frozen-callback-token',
          },
        },
      }),
    );

    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        context: expect.objectContaining({
          token: '',
          _apiType: 'enterprise',
        }),
      }),
    );
  });

  it('marks the touch failed for non-shadow non-reply outcomes', async () => {
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
    reengagementAgent.compose.mockResolvedValue(outcome);

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).not.toHaveBeenCalled();
    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:evt-1',
      'failed',
    );
  });

  it('does not directly write assistant history after delivery because the channel callback owns it', async () => {
    const now = Date.UTC(2026, 5, 24, 2, 0, 0);
    jest.spyOn(Date, 'now').mockReturnValue(now);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
    });

    await buildProcessor().process(makeJob());

    expect(delivery.deliver).toHaveBeenCalled();
    expect(touchLedger.markSent).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:evt-1',
      'sess-1',
      now,
    );
    expect(touchLedger.markFailedOrUnknown).not.toHaveBeenCalled();
  });

  it('does not generate or deliver duplicate inflight slots', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    touchLedger.reserve.mockResolvedValue('duplicate_inflight');
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.markDeliveryAttempted).not.toHaveBeenCalled();
    expect(reengagementAgent.compose).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('does not generate or run turn-end when a duplicate sent slot is skipped', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    touchLedger.reserve.mockResolvedValue('duplicate_sent');
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await buildProcessor().process(makeJob());

    expect(reengagementAgent.compose).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('runs turn-end without assistant projection when delivery fails and marks the touch unknown', async () => {
    const runTurnEnd = jest.fn().mockResolvedValue(undefined);
    const error = new Error('delivery down');
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    delivery.deliver.mockRejectedValue(error);
    reengagementAgent.compose.mockResolvedValue({
      kind: 'reply',
      reply: { text: '还想看看附近岗位吗？' },
      toolCalls: [],
      scenarioCode: 'opening_no_reply',
      runTurnEnd,
    });

    await expect(buildProcessor().process(makeJob())).rejects.toThrow('delivery down');

    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:evt-1',
      'unknown',
    );
    // 送达与否未知按未送达处理（HC-4）：仍完成用户侧记忆收尾，但不投影助手轮次。
  });

  it('does not mark sent or write history when the passive delivery pipeline skips sending', async () => {
    systemConfig.getAgentReplyConfig.mockResolvedValue({
      reengagementEnabled: true,
      reengagementShadow: false,
    });
    delivery.deliver.mockResolvedValue({
      success: true,
      segmentCount: 0,
      failedSegments: 0,
      deliveredSegments: 0,
      totalTime: 0,
      skipped: true,
      skipReason: 'hosting_paused',
    });

    await buildProcessor().process(makeJob());

    expect(touchLedger.markSent).not.toHaveBeenCalled();
    expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
      'sess-1:opening_no_reply:evt-1',
      'failed',
    );
    expect(tracking.trackOutcomeNotReply).toHaveBeenCalledWith(
      expect.anything(),
      'delivery_skipped',
      expect.stringMatching(/^batch_sess-1_\d+$/),
      'delivery_skipped:hosting_paused',
    );
  });

  it('processes immediately when fired outside the former delivery window', async () => {
    const now = Date.UTC(2026, 5, 24, 14, 0, 0); // 22:00 Shanghai
    jest.spyOn(Date, 'now').mockReturnValue(now);

    await buildProcessor().process(makeJob({ id: 'late-job' }));

    expect(reengagementAgent.compose).toHaveBeenCalledTimes(1);
    expect(queue.add).not.toHaveBeenCalled();
    expect(tracking.trackRescheduled).not.toHaveBeenCalled();
  });

  describe('二次触发追溯落库埋点', () => {
    const expectedIdentity = expect.objectContaining({
      sessionId: 'sess-1',
      scenarioCode: 'opening_no_reply',
      anchorEventId: 'evt-1',
    });

    beforeEach(() => {
      // 前序用例会固定 Date.now；追溯断言使用稳定时间。
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
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('does not apply session cooldown to time-anchored interview reminders', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 5, 0, 0));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-24 14:00',
      });
      touchLedger.isInSessionTouchCooldown.mockResolvedValue(true);
      session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'booked' }));
      await buildProcessor().process(
        makeJob({
          data: {
            sessionRef,
            scenarioCode: 'interview_reminder',
            anchorEventId: 'evt-b',
            anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
            workOrderId: 555,
            expectedInterviewAt: Date.UTC(2026, 5, 24, 6, 0, 0),
          },
        }),
      );

      expect(tracking.trackStopped).not.toHaveBeenCalledWith(
        expect.anything(),
        'session_touch_cooldown',
      );
      expect(reengagementAgent.compose).toHaveBeenCalled();
    });

    it('tracks frequency block', async () => {
      touchLedger.isOverFrequencyLimit.mockResolvedValue(true);

      await buildProcessor().process(makeJob());

      expect(tracking.trackFrequencyBlocked).toHaveBeenCalledWith(expectedIdentity);
    });

    it('tracks session touch cooldown before generating', async () => {
      touchLedger.isInSessionTouchCooldown.mockResolvedValue(true);

      await buildProcessor().process(makeJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expectedIdentity,
        'session_touch_cooldown',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('tracks shadow with generated text', async () => {
      reengagementAgent.compose.mockResolvedValue(
        asExecution(
          {
            kind: 'reply',
            reply: { text: '还在考虑吗？' },
            generatedText: '还在考虑吗？',
            toolCalls: [],
            scenarioCode: 'opening_no_reply',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
          {
            agentRequest: {
              modelId: 'openai/gpt-5.1',
              system: 'system prompt',
              messages: [{ role: 'user', content: '[系统主动跟进]' }],
            },
          },
        ),
      );

      await buildProcessor().process(makeJob());

      expect(reengagementAgent.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: expect.stringMatching(/^batch_sess-1_\d+$/),
          scenario: expect.objectContaining({ code: 'opening_no_reply' }),
        }),
      );
      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expectedIdentity,
        expect.objectContaining({
          outcomeKind: 'reply',
          generatedText: '还在考虑吗？',
          reason: 'shadow_mode',
          batchId: expect.stringMatching(/^batch_sess-1_\d+$/),
        }),
      );
      expect(touchLedger.markSent).not.toHaveBeenCalled();
      expect(messageTracking.recordProactiveTurn).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'sess-1',
          status: 'success',
          scenario: 'reengagement:opening_no_reply',
          messageId: expect.stringMatching(/^batch_sess-1_\d+$/),
          batchId: expect.stringMatching(/^batch_sess-1_\d+$/),
          replyPreview: '还在考虑吗？',
          tokenUsage: 15,
          agentInvocation: expect.objectContaining({
            request: expect.objectContaining({
              agentRequest: expect.objectContaining({
                modelId: 'openai/gpt-5.1',
                system: 'system prompt',
              }),
              dispatchMode: 'proactive',
              proactiveDirective: expect.stringContaining('开场已发'),
            }),
            response: expect.objectContaining({
              reply: expect.objectContaining({ content: '还在考虑吗？' }),
              timings: expect.objectContaining({
                durations: expect.objectContaining({
                  aiStartToAiEndMs: expect.any(Number),
                  totalMs: expect.any(Number),
                }),
              }),
            }),
          }),
        }),
      );
    });

    it('tracks reserved → attempted → sent along the real delivery path', async () => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
      });
      reengagementAgent.compose.mockResolvedValue({
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
      expect(touchLedger.markSent).toHaveBeenCalledWith(
        'sess-1:opening_no_reply:evt-1',
        'sess-1',
        Date.UTC(2026, 5, 24, 2, 0, 0),
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
      reengagementAgent.compose.mockResolvedValue({
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
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });
  });

  describe('存量任务渠道身份兜底', () => {
    beforeEach(() => {
      jest.restoreAllMocks();
      // 10:00 上海，投递窗口内
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 24, 2, 0, 0));
      reengagementAgent.compose.mockResolvedValue({
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
      reengagementAgent.compose.mockResolvedValue({
        kind: 'reply',
        reply: { text: '面试提醒' },
        toolCalls: [],
        scenarioCode: 'interview_reminder',
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });
    });

    it('stops when the work order was cancelled outside the chat', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面取消',
      });

      await buildProcessor().process(bookingJob());

      expect(sponge.getWorkOrderById).toHaveBeenCalledWith(555);
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.objectContaining({ scenarioCode: 'interview_reminder' }),
        'work_order_not_active:约面取消',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('resolves a newly booked work order before scheduling the formal delayed job', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        jobId: 9002,
        currentStatus: '约面成功',
        interviewTime: '2026-06-25 14:00',
      });
      sponge.fetchJobs.mockResolvedValue({
        total: 1,
        jobs: [
          {
            interviewProcess: {
              firstInterview: {
                firstInterviewWay: 'AI面试',
              },
            },
          },
        ],
      });

      await buildProcessor().process(
        bookingJob({
          resolveBookingAtFire: true,
          expectedInterviewAt: undefined,
          interviewType: undefined,
        }),
      );

      expect(scheduler.scheduleFollowUp).toHaveBeenCalledWith(
        expect.objectContaining({
          scenarioCode: 'interview_reminder',
          workOrderId: 555,
          expectedInterviewAt,
          interviewType: 'AI面试',
        }),
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('does not create formal delayed jobs for a non-active resolved work order', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面取消',
      });

      await buildProcessor().process(
        bookingJob({
          resolveBookingAtFire: true,
          expectedInterviewAt: undefined,
          interviewType: undefined,
        }),
      );

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'work_order_not_active:约面取消',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('passes the per-bot token context to the sponge work-order lookup', async () => {
      // 多 bot 企业 per-bot token ≠ 全局 fallback，不带 botImId 查工单会静默 miss，
      // 外部取消检测整条失效（2026-07-06 review）
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面取消',
      });

      await buildProcessor().process(
        bookingJob({ channelIdentity: { botImId: 'bot-1', candidateName: '张三' } }),
      );

      expect(sponge.getWorkOrderById).toHaveBeenCalledWith(555, { botImId: 'bot-1' });
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'work_order_not_active:约面取消',
      );
    });

    it('stops the reminder when the interview already happened', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '面试成功',
      });

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'work_order_not_active:面试成功',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('stops post_interview_followup when the interview result is already known', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 25, 7, 0, 0));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '面试成功',
        interviewTime: '2026-06-25 14:00',
      });

      await buildProcessor().process(bookingJob({ scenarioCode: 'post_interview_followup' }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'work_order_not_active:面试成功',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it.each(['约面待确认', '约面成功'])(
      'allows the semantic gate for active work-order status %s',
      async (currentStatus) => {
        jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 25, 8, 0, 0));
        sponge.getWorkOrderById.mockResolvedValue({
          workOrderId: 555,
          currentStatus,
          interviewTime: '2026-06-25 14:00',
        });

        await buildProcessor().process(bookingJob({ scenarioCode: 'post_interview_followup' }));

        expect(tracking.trackStopped).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.stringContaining('work_order_not_active:'),
        );
        expect(reengagementAgent.compose).toHaveBeenCalled();
      },
    );

    it.each(['约面失败', '约面取消', '面试失败', '面试成功', '上岗失败', '上岗成功', '已离职'])(
      'stops both post-booking scenarios for non-active status %s',
      async (currentStatus) => {
        sponge.getWorkOrderById.mockResolvedValue({
          workOrderId: 555,
          currentStatus,
          interviewTime: '2026-06-25 14:00',
        });

        await buildProcessor().process(bookingJob({ scenarioCode: 'post_interview_followup' }));

        expect(tracking.trackStopped).toHaveBeenCalledWith(
          expect.anything(),
          `work_order_not_active:${currentStatus}`,
        );
        expect(reengagementAgent.compose).not.toHaveBeenCalled();
      },
    );

    it('fails closed when the work-order status is missing', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        interviewTime: '2026-06-25 14:00',
      });

      await buildProcessor().process(bookingJob({ scenarioCode: 'post_interview_followup' }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'work_order_status_unavailable',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('does not trust a different interview time stored in active_booking', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 16:00' },
      ]);

      await expect(buildProcessor().process(bookingJob())).rejects.toThrow(
        'reengagement_booking_context_unavailable:555',
      );

      expect(reengagementAgent.compose).not.toHaveBeenCalled();
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
    });

    it('detects backend time changes via the sponge interviewTime field', async () => {
      // 后台改时间：海绵 interviewTime 已变，本地 active_booking 还是旧时间——以海绵为准
      sponge.getWorkOrderById.mockResolvedValue({
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
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 25, 5, 0, 0));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-25 14:00',
      });
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 16:00' },
      ]);

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).toHaveBeenCalled();
    });

    it('does not schedule a reminder replacement when the new time is already past', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-20 10:00',
      });

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_passed',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
    });

    it('does not use a matching active_booking time when Sponge is unavailable', async () => {
      longTerm.getActiveBookings.mockResolvedValue([
        { work_order_id: 555, linked_at: 'x', interview_time: '2026-06-25 14:00' },
      ]);

      await expect(buildProcessor().process(bookingJob())).rejects.toThrow(
        'reengagement_booking_context_unavailable:555',
      );

      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('fails closed when neither Sponge nor active_booking yields verification data', async () => {
      sponge.getWorkOrderById.mockResolvedValue(null);
      longTerm.getActiveBookings.mockResolvedValue([]);

      await expect(buildProcessor().process(bookingJob())).rejects.toThrow(
        'reengagement_booking_context_unavailable:555',
      );

      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('exempts verifiable booking follow-ups from the replied-after-anchor rule', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 25, 5, 0, 0));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-25 14:00',
      });
      session.getAuthoritativeState.mockResolvedValue(
        baseState({ terminal: 'booked', lastCandidateMessageAt: anchorAt + 1 }),
      );

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).toHaveBeenCalled();
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
        'missing_authoritative_work_order_id',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('stops legacy booking follow-ups that have no frozen interview time', async () => {
      session.getAuthoritativeState.mockResolvedValue(baseState({ terminal: 'booked' }));

      await buildProcessor().process(
        bookingJob({ workOrderId: undefined, expectedInterviewAt: undefined }),
      );

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'missing_authoritative_work_order_id',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });
  });
});
