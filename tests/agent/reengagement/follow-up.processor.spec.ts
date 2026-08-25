import { FollowUpProcessor } from '@agent/reengagement/follow-up.processor';
import { REENGAGEMENT_JOB_NAME } from '@agent/reengagement/follow-up-scheduler.service';
import type { ReengagementSessionState } from '@memory/reengagement-recall.types';

const sessionRef = { corpId: 'corp-1', userId: 'user-1', sessionId: 'sess-1' };

const baseState = (over: Partial<ReengagementSessionState> = {}): ReengagementSessionState => ({
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
  let session: { getReengagementState: jest.Mock; getSessionState: jest.Mock };
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
  let chatSession: { getChatHistory: jest.Mock };
  let messageProcessing: { getLatestReceivedAtByChatId: jest.Mock };
  let sponge: {
    getWorkOrderById: jest.Mock;
    fetchJobs: jest.Mock;
  };
  let longTerm: { getActiveBookings: jest.Mock };
  let scheduler: {
    scheduleFollowUp: jest.Mock;
    scheduleOnboardingCheck: jest.Mock;
    stopPendingJobsForSessionScenario: jest.Mock;
  };
  let groupInvite: { invite: jest.Mock };
  let handoffRecorder: { record: jest.Mock };
  let handoffNotifier: { notify: jest.Mock };
  let configService: { get: jest.Mock };
  let delivery: { deliver: jest.Mock };

  beforeEach(() => {
    jest.useRealTimers();
    queue = { process: jest.fn(), add: jest.fn().mockResolvedValue(undefined) };
    session = {
      getReengagementState: jest.fn().mockResolvedValue(baseState()),
      getSessionState: jest.fn().mockResolvedValue({ facts: null }),
    };
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
    scheduler = {
      scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }),
      scheduleOnboardingCheck: jest.fn().mockResolvedValue({ scheduled: true }),
      stopPendingJobsForSessionScenario: jest.fn().mockResolvedValue(0),
    };
    groupInvite = {
      invite: jest.fn().mockResolvedValue({ success: true, groupName: '上海兼职群' }),
    };
    handoffRecorder = { record: jest.fn().mockResolvedValue('inserted') };
    handoffNotifier = { notify: jest.fn().mockResolvedValue(true) };
    configService = {
      get: jest.fn((key: string) =>
        key === 'STRIDE_ENTERPRISE_TOKEN' ? 'stride-enterprise-token' : undefined,
      ),
    };
    tracking = {
      resolveChannelIdentity: jest.fn().mockResolvedValue(null),
      trackDisabledAtFire: jest.fn(),
      trackScheduleSkipped: jest.fn(),
      trackStopped: jest.fn(),
      trackFrequencyBlocked: jest.fn(),
      trackRescheduled: jest.fn(),
      trackShadow: jest.fn(),
      trackDuplicate: jest.fn(),
      trackReserved: jest.fn(),
      trackOutcomeNotReply: jest.fn(),
      trackDeliveryAttempted: jest.fn(),
      trackSent: jest.fn(),
      trackGroupInviteResult: jest.fn(),
      trackDeliveryUnknown: jest.fn(),
    };
    messageTracking = { recordProactiveTurn: jest.fn() };
    // 候选人待答闸默认不命中：我方说了最后一句
    chatSession = {
      getChatHistory: jest
        .fn()
        .mockResolvedValue([
          { role: 'assistant', content: '好的', timestamp: Date.now() - 60_000 },
        ]),
    };
    messageProcessing = { getLatestReceivedAtByChatId: jest.fn().mockResolvedValue(null) };
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
      chatSession as never,
      messageProcessing as never,
      sponge as never,
      longTerm as never,
      scheduler as never,
      groupInvite as never,
      handoffRecorder as never,
      handoffNotifier as never,
      configService as never,
      withDelivery ? (delivery as never) : undefined,
    );

  it('registers the configured follow-up job name', () => {
    buildProcessor().onModuleInit();

    expect(queue.process).toHaveBeenCalledWith(REENGAGEMENT_JOB_NAME, 2, expect.any(Function));
  });

  it('候选人待答闸：最后一条候选人消息从未进处理管道时停止触达（badcase recvqz4yWbdIKm 静默丢 turn）', async () => {
    const lastUserAt = Date.now() - 30 * 60 * 1000; // 30 分钟前，远超宽限期
    chatSession.getChatHistory.mockResolvedValue([
      { role: 'assistant', content: '帮你约好了', timestamp: lastUserAt - 60_000 },
      { role: 'user', content: '因为我是暑假工', timestamp: lastUserAt },
    ]);
    // 最近处理记录早于候选人最后消息 → 该轮被静默丢弃
    messageProcessing.getLatestReceivedAtByChatId.mockResolvedValue(lastUserAt - 10 * 60 * 1000);

    await buildProcessor().process(makeJob());

    expect(tracking.trackStopped).toHaveBeenCalledWith(
      expect.anything(),
      'pending_candidate_message',
    );
    expect(reengagementAgent.compose).not.toHaveBeenCalled();
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it('候选人待答闸：轮次已进管道（含主动沉默）时不拦', async () => {
    const lastUserAt = Date.now() - 30 * 60 * 1000;
    chatSession.getChatHistory.mockResolvedValue([
      { role: 'user', content: '好的谢谢', timestamp: lastUserAt },
    ]);
    // 处理记录 received_at 覆盖了该消息（Agent 主动沉默也有记录）
    messageProcessing.getLatestReceivedAtByChatId.mockResolvedValue(lastUserAt + 1_000);

    await buildProcessor().process(makeJob());

    expect(tracking.trackStopped).not.toHaveBeenCalledWith(
      expect.anything(),
      'pending_candidate_message',
    );
  });

  it('候选人待答闸：消息在宽限期内（可能在途 debounce）不拦', async () => {
    const lastUserAt = Date.now() - 2 * 60 * 1000; // 2 分钟前，宽限期 10 分钟内
    chatSession.getChatHistory.mockResolvedValue([
      { role: 'user', content: '在吗', timestamp: lastUserAt },
    ]);
    messageProcessing.getLatestReceivedAtByChatId.mockResolvedValue(null);

    await buildProcessor().process(makeJob());

    expect(tracking.trackStopped).not.toHaveBeenCalledWith(
      expect.anything(),
      'pending_candidate_message',
    );
  });

  it('候选人待答闸：历史查询失败 fail open 放行', async () => {
    chatSession.getChatHistory.mockRejectedValue(new Error('supabase down'));

    await buildProcessor().process(makeJob());

    expect(tracking.trackStopped).not.toHaveBeenCalledWith(
      expect.anything(),
      'pending_candidate_message',
    );
  });

  it.each(['interview_reminder', 'post_interview_followup'] as const)(
    '真人介入闸：候选人消息后有 MOBILE_PUSH 真人文本时停止 %s',
    async (scenarioCode) => {
      const anchorAt = Date.UTC(2026, 6, 22, 8, 20, 0);
      const candidateAt = anchorAt + 60_000;
      const humanReplyAt = candidateAt + 30_000;
      jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 23, 9, 0, 0));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-07-23 18:00',
      });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
      chatSession.getChatHistory.mockResolvedValue([
        {
          role: 'user',
          content: '没有餐饮经验',
          timestamp: candidateAt,
          source: 'MOBILE_PUSH',
          messageType: 'TEXT',
          isSelf: false,
        },
        {
          role: 'assistant',
          content: '那不太合适',
          timestamp: humanReplyAt,
          source: 'MOBILE_PUSH',
          messageType: 'TEXT',
          isSelf: true,
        },
      ]);

      await buildProcessor().process(
        makeJob({
          data: {
            sessionRef,
            scenarioCode,
            anchorEventId: 'wo555:iv1784800800000',
            anchorAt,
            workOrderId: 555,
            expectedInterviewAt: Date.UTC(2026, 6, 23, 10, 0, 0),
          },
        }),
      );

      expect(chatSession.getChatHistory).toHaveBeenCalledWith('sess-1', 200, {
        startTimeInclusive: anchorAt,
        endTimeInclusive: Date.UTC(2026, 6, 23, 9, 0, 0),
      });
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'human_intervention_after_candidate',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();
    },
  );

  it('真人介入闸：候选人 timeout 但没有真人回复时不冒充已处理回话（兼容 PR #766）', async () => {
    const anchorAt = Date.UTC(2026, 6, 22, 8, 20, 0);
    const candidateAt = anchorAt + 60_000;
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 23, 5, 0, 0));
    sponge.getWorkOrderById.mockResolvedValue({
      workOrderId: 555,
      currentStatus: '约面成功',
      interviewTime: '2026-07-23 14:00',
    });
    session.getReengagementState.mockResolvedValue(
      baseState({
        terminal: 'booked',
        lastCandidateMessageAt: candidateAt,
        lastProcessedCandidateMessageAt: anchorAt,
      }),
    );
    chatSession.getChatHistory.mockResolvedValue([
      {
        role: 'user',
        content: '已面试，等您通知',
        timestamp: candidateAt,
        source: 'MOBILE_PUSH',
        messageType: 'TEXT',
        isSelf: false,
      },
    ]);
    // timeout 轮仍有 processing record，不属于“从未进管道”的待答闸。
    messageProcessing.getLatestReceivedAtByChatId.mockResolvedValue(candidateAt);

    await buildProcessor().process(
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'wo555:iv1784786400000',
          anchorAt,
          workOrderId: 555,
          expectedInterviewAt: Date.UTC(2026, 6, 23, 6, 0, 0),
        },
      }),
    );

    expect(tracking.trackStopped).not.toHaveBeenCalledWith(
      expect.anything(),
      'human_intervention_after_candidate',
    );
    expect(reengagementAgent.compose).toHaveBeenCalled();
  });

  it('真人介入闸：API_SEND 或非文本自发消息不算真人手打', async () => {
    const anchorAt = Date.UTC(2026, 6, 22, 8, 20, 0);
    jest.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 6, 23, 5, 0, 0));
    sponge.getWorkOrderById.mockResolvedValue({
      workOrderId: 555,
      currentStatus: '约面成功',
      interviewTime: '2026-07-23 14:00',
    });
    session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
    chatSession.getChatHistory.mockResolvedValue([
      {
        role: 'user',
        content: '好的',
        timestamp: anchorAt + 1_000,
        source: 'MOBILE_PUSH',
        messageType: 'TEXT',
        isSelf: false,
      },
      {
        role: 'assistant',
        content: '系统自动回复',
        timestamp: anchorAt + 2_000,
        source: 'API_SEND',
        messageType: 'TEXT',
        isSelf: true,
      },
      {
        role: 'assistant',
        content: '[入群邀请] 已发送入群邀请卡片',
        timestamp: anchorAt + 3_000,
        source: 'MOBILE_PUSH',
        messageType: 'ROOM_INVITE',
        isSelf: true,
      },
    ]);

    await buildProcessor().process(
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'interview_reminder',
          anchorEventId: 'wo555:iv1784786400000',
          anchorAt,
          workOrderId: 555,
          expectedInterviewAt: Date.UTC(2026, 6, 23, 6, 0, 0),
        },
      }),
    );

    expect(tracking.trackStopped).not.toHaveBeenCalledWith(
      expect.anything(),
      'human_intervention_after_candidate',
    );
    expect(reengagementAgent.compose).toHaveBeenCalled();
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

  describe('store presentation group invite escalation', () => {
    const escalatedJob = () =>
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'store_presented_no_reply',
          anchorEventId: 'evt-store-2',
          anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
          escalateToGroupInvite: true,
          channelIdentity: {
            candidateName: '候选人',
            managerName: 'bot-user-1',
            botImId: 'bot-im-1',
            imContactId: 'contact-1',
          },
        },
      });

    const enableEscalation = (shadow = false) => {
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: shadow,
        reengagementScenarioRollout: {
          store_presented_no_reply: true,
          'store_presented_no_reply:invite': true,
        },
      });
      session.getReengagementState.mockResolvedValue(
        baseState({ presentedStores: [{ jobId: 519709 }], storePresentationRounds: 2 }),
      );
      session.getSessionState.mockResolvedValue({
        facts: {
          preferences: {
            city: {
              value: '上海',
              confidence: 'high',
              source: 'candidate_quote',
              evidence: '我在上海找工作',
            },
          },
        },
      });
      reengagementAgent.compose.mockResolvedValue(
        asExecution({
          kind: 'reply',
          reply: { text: '这批岗位也不感兴趣吗？稍后邀请你进兼职岗位群继续看看。' },
          generatedText: '这批岗位也不感兴趣吗？稍后邀请你进兼职岗位群继续看看。',
          toolCalls: [],
          scenarioCode: 'store_presented_no_reply',
          agentSteps: [],
        }),
      );
    };

    it('invites only after markSent succeeds, records success, and closes pending pre-booking jobs', async () => {
      const now = Date.UTC(2026, 5, 24, 2, 0, 0);
      jest.spyOn(Date, 'now').mockReturnValue(now);
      enableEscalation();

      await buildProcessor().process(escalatedJob());

      expect(groupInvite.invite).toHaveBeenCalledWith(
        expect.objectContaining({
          corpId: 'corp-1',
          userId: 'user-1',
          sessionId: 'sess-1',
          botImId: 'bot-im-1',
          botUserId: 'bot-user-1',
          contactWxid: 'user-1',
          city: '上海',
          turnKey: 'batch_sess-1_1782266400000',
        }),
      );
      expect(touchLedger.markSent.mock.invocationCallOrder[0]).toBeLessThan(
        groupInvite.invite.mock.invocationCallOrder[0],
      );
      expect(tracking.trackGroupInviteResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ success: true, groupName: '上海兼职群' }),
      );
      expect(scheduler.stopPendingJobsForSessionScenario).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionRef,
          reason: 'candidate_invited_to_group',
        }),
      );
    });

    it('records a failed invite without retrying or rolling back the delivered copy', async () => {
      enableEscalation();
      groupInvite.invite.mockResolvedValue({ success: false, reason: 'group_full' });

      await buildProcessor().process(escalatedJob());

      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(touchLedger.markSent).toHaveBeenCalledTimes(1);
      expect(groupInvite.invite).toHaveBeenCalledTimes(1);
      expect(tracking.trackGroupInviteResult).toHaveBeenCalledWith(expect.anything(), {
        success: false,
        reason: 'group_full',
      });
      expect(scheduler.stopPendingJobsForSessionScenario).not.toHaveBeenCalled();
      expect(touchLedger.markFailedOrUnknown).not.toHaveBeenCalled();
    });

    it('skips the invite with a ledger reason when session facts have no intent city', async () => {
      enableEscalation();
      session.getSessionState.mockResolvedValue({ facts: null });

      await buildProcessor().process(escalatedJob());

      expect(groupInvite.invite).not.toHaveBeenCalled();
      expect(tracking.trackGroupInviteResult).toHaveBeenCalledWith(expect.anything(), {
        success: false,
        skipped: true,
        reason: 'no_city',
      });
      expect(touchLedger.markSent).toHaveBeenCalled();
    });

    it('treats alreadyInGroup as a successful closeout without another escalation task', async () => {
      enableEscalation();
      groupInvite.invite.mockResolvedValue({
        success: true,
        alreadyInGroup: true,
        groupName: '上海兼职群',
      });

      await buildProcessor().process(escalatedJob());

      expect(groupInvite.invite).toHaveBeenCalledTimes(1);
      expect(tracking.trackGroupInviteResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ success: true, alreadyInGroup: true }),
      );
      expect(scheduler.stopPendingJobsForSessionScenario).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'candidate_already_in_group' }),
      );
    });

    it('never calls invite in shadow mode', async () => {
      enableEscalation(true);

      await buildProcessor().process(escalatedJob());

      expect(reengagementAgent.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          jobData: expect.objectContaining({ escalateToGroupInvite: true }),
        }),
      );
      expect(delivery.deliver).not.toHaveBeenCalled();
      expect(touchLedger.markSent).not.toHaveBeenCalled();
      expect(groupInvite.invite).not.toHaveBeenCalled();
    });

    it('degrades to ordinary store copy when the invite child key is explicitly off', async () => {
      enableEscalation();
      // 0820 裁定后子键缺省开：验证降级路径必须显式关子键
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
        reengagementScenarioRollout: {
          store_presented_no_reply: true,
          'store_presented_no_reply:invite': false,
        },
      });

      await buildProcessor().process(escalatedJob());

      expect(reengagementAgent.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          jobData: expect.objectContaining({ escalateToGroupInvite: false }),
        }),
      );
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
      expect(groupInvite.invite).not.toHaveBeenCalled();
    });

    it('keeps non-reply outcomes physically unable to reach invite', async () => {
      enableEscalation();
      reengagementAgent.compose.mockResolvedValue(
        asExecution({
          kind: 'skipped',
          toolCalls: [],
          scenarioCode: 'store_presented_no_reply',
          agentSteps: [],
        }),
      );

      await buildProcessor().process(escalatedJob());

      expect(delivery.deliver).not.toHaveBeenCalled();
      expect(touchLedger.markSent).not.toHaveBeenCalled();
      expect(groupInvite.invite).not.toHaveBeenCalled();
    });

    it('keeps failed or unknown delivery physically unable to reach invite', async () => {
      enableEscalation();
      delivery.deliver.mockRejectedValue(new Error('gateway timeout'));

      await expect(buildProcessor().process(escalatedJob())).rejects.toThrow('gateway timeout');

      expect(touchLedger.markSent).not.toHaveBeenCalled();
      expect(groupInvite.invite).not.toHaveBeenCalled();
      expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
        'sess-1:store_presented_no_reply:evt-store-2',
        'unknown',
      );
    });

    it('keeps an explicitly skipped delivery physically unable to reach invite', async () => {
      enableEscalation();
      delivery.deliver.mockResolvedValue({
        success: true,
        segmentCount: 0,
        failedSegments: 0,
        deliveredSegments: 0,
        totalTime: 0,
        skipped: true,
        skipReason: 'hosting_paused',
      });

      await buildProcessor().process(escalatedJob());

      expect(touchLedger.markSent).not.toHaveBeenCalled();
      expect(groupInvite.invite).not.toHaveBeenCalled();
      expect(touchLedger.markFailedOrUnknown).toHaveBeenCalledWith(
        'sess-1:store_presented_no_reply:evt-store-2',
        'failed',
      );
    });
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
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));

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
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
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

    it('completes a sweep-provided onboarding bot identity with the delivery recipient', async () => {
      tracking.resolveChannelIdentity.mockResolvedValue({
        candidateName: '张三',
        managerName: '经理A',
        botImId: 'stale-bot',
        imContactId: 'contact-1',
      });
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '面试成功' });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));

      await buildProcessor().process(
        makeJob({
          data: {
            sessionRef,
            scenarioCode: 'post_interview_onboarding',
            anchorEventId: 'wo901:pass',
            anchorAt: Date.UTC(2026, 5, 21, 2, 0, 0),
            workOrderId: 901,
            channelIdentity: { botImId: 'event-bot' },
          },
        }),
      );

      expect(tracking.resolveChannelIdentity).toHaveBeenCalledWith('sess-1');
      expect(reengagementAgent.compose).toHaveBeenCalledWith(
        expect.objectContaining({
          jobData: expect.objectContaining({ channelIdentity: { botImId: 'event-bot' } }),
        }),
      );
      expect(tracking.trackShadow).toHaveBeenCalledWith(
        expect.objectContaining({ botImId: 'event-bot', imContactId: 'contact-1' }),
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
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
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

    it('schedules both arrival reminder and d2 confirmation when signup gap is at least 3 Shanghai days', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-24 09:00',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(
        bookingJob({ resolveBookingAtFire: true, expectedInterviewAt: undefined }),
      );

      expect(scheduler.scheduleFollowUp).toHaveBeenCalledTimes(2);
      expect(scheduler.scheduleFollowUp).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          anchorEventId: `wo555:iv${Date.UTC(2026, 5, 27, 6)}:interview_reminder:d2`,
          touchVariant: 'd2_confirm',
        }),
      );
    });

    it('schedules only arrival reminder when signup gap is under 3 Shanghai days', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-25 09:00',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(
        bookingJob({ resolveBookingAtFire: true, expectedInterviewAt: undefined }),
      );

      expect(scheduler.scheduleFollowUp).toHaveBeenCalledTimes(1);
      expect(tracking.trackScheduleSkipped).toHaveBeenCalledWith(
        expect.objectContaining({ anchorEventId: expect.stringMatching(/:d2$/) }),
        'signup_interview_gap_lt_3d',
      );
    });

    it('fails closed and skips d2 confirmation when signUpTime is missing', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(
        bookingJob({ resolveBookingAtFire: true, expectedInterviewAt: undefined }),
      );

      expect(scheduler.scheduleFollowUp).toHaveBeenCalledTimes(1);
      expect(tracking.trackScheduleSkipped).toHaveBeenCalledWith(
        expect.anything(),
        'signup_interview_gap_lt_3d',
      );
    });

    it('uses the d2 delay child key during fire-time calibration', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 25, 6));
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: true,
        reengagementScenarioDelayMinutes: {
          interview_reminder: 60,
          'interview_reminder:d2': 2880,
        },
      });
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-23 09:00',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(
        bookingJob({
          anchorEventId: `wo555:iv${Date.UTC(2026, 5, 27, 6)}:interview_reminder:d2`,
          touchVariant: 'd2_confirm',
        }),
      );

      expect(tracking.trackStopped).not.toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_changed',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).toHaveBeenCalled();
    });

    it('stops d2 confirmation when the interview is less than 24 hours away', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 26, 7));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-23 09:00',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(bookingJob({ touchVariant: 'd2_confirm' }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(expect.anything(), 'interview_too_close');
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('rechecks the signup gap for a d2 task at fire time', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 25, 6));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-25 09:00',
        interviewTime: '2026-06-27 14:00',
      });

      await buildProcessor().process(bookingJob({ touchVariant: 'd2_confirm' }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'signup_interview_gap_lt_3d',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('does not create a d2 replacement when rescheduling makes the signup gap ineligible', async () => {
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 25, 6));
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-29 09:00',
        interviewTime: '2026-07-01 14:00',
      });

      await buildProcessor().process(bookingJob({ touchVariant: 'd2_confirm' }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'signup_interview_gap_lt_3d',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
    });

    it('keeps d2 in shadow when its child key is explicitly off without affecting arrival reminder rollout', async () => {
      // 0820 裁定后子键缺省开：验证单独关 d2 必须显式 false
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
        reengagementScenarioRollout: {
          interview_reminder: true,
          'interview_reminder:d2': false,
        },
        reengagementScenarioDelayMinutes: { 'interview_reminder:d2': 2880 },
      });
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 555,
        currentStatus: '约面成功',
        signUpTime: '2026-06-23 09:00',
        interviewTime: '2026-06-27 14:00',
      });
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 25, 6));

      await buildProcessor().process(bookingJob({ touchVariant: 'd2_confirm' }));

      expect(tracking.trackShadow).toHaveBeenCalled();
      expect(delivery.deliver).not.toHaveBeenCalled();

      tracking.trackShadow.mockClear();
      reengagementAgent.compose.mockClear();
      (Date.now as jest.Mock).mockReturnValue(Date.UTC(2026, 5, 27, 5));
      await buildProcessor().process(bookingJob());

      expect(tracking.trackShadow).not.toHaveBeenCalled();
      expect(delivery.deliver).toHaveBeenCalledTimes(1);
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
          anchorAt: Date.UTC(2026, 5, 24, 2, 0, 0),
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
      session.getReengagementState.mockResolvedValue(
        baseState({ terminal: 'booked', lastCandidateMessageAt: anchorAt + 1 }),
      );

      await buildProcessor().process(bookingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).toHaveBeenCalled();
    });

    it('keeps the replied-after-anchor rule for legacy jobs without workOrderId', async () => {
      session.getReengagementState.mockResolvedValue(
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
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));

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

  describe('post-interview onboarding', () => {
    const passedAt = Date.UTC(2026, 7, 17, 2, 0, 0);
    const onboardingJob = (over: Record<string, unknown> = {}) =>
      makeJob({
        data: {
          sessionRef,
          scenarioCode: 'post_interview_onboarding',
          anchorEventId: 'wo901:pass',
          anchorAt: passedAt,
          workOrderId: 901,
          channelIdentity: {
            botImId: 'bot-1',
            imContactId: 'contact-1',
            candidateName: '候选人A',
            managerName: '经理A',
          },
          ...over,
        },
      });

    it.each([
      ['面试成功', null, false, true],
      ['上岗成功', 'already_onboarded', false, false],
      ['上岗失败', 'onboarding_intervention_dispatched', true, false],
      ['已离职', 'onboarding_intervention_dispatched', true, false],
      ['约面成功', 'work_order_regressed', false, false],
    ] as const)(
      'dispatches current status %s deterministically',
      async (currentStatus, stoppedReason, expectsHandoff, expectsCompose) => {
        sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus });
        session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));

        await buildProcessor().process(onboardingJob());

        if (stoppedReason) {
          expect(tracking.trackStopped).toHaveBeenCalledWith(expect.anything(), stoppedReason);
        } else {
          expect(tracking.trackStopped).not.toHaveBeenCalled();
        }
        expect(handoffRecorder.record).toHaveBeenCalledTimes(expectsHandoff ? 1 : 0);
        expect(handoffNotifier.notify).toHaveBeenCalledTimes(expectsHandoff ? 1 : 0);
        expect(reengagementAgent.compose).toHaveBeenCalledTimes(expectsCompose ? 1 : 0);
      },
    );

    it('does not enter booking validity or 1.5 time calibration for interview.passed', async () => {
      sponge.getWorkOrderById.mockResolvedValue({
        workOrderId: 901,
        currentStatus: '面试成功',
        interviewTime: '2026-09-30 18:00',
      });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));

      await buildProcessor().process(onboardingJob());

      expect(tracking.trackStopped).not.toHaveBeenCalledWith(
        expect.anything(),
        'interview_time_changed',
      );
      expect(scheduler.scheduleFollowUp).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).toHaveBeenCalled();
    });

    it('keeps the human-intervention gate for the onboarding touch', async () => {
      const candidateAt = passedAt + 60_000;
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '面试成功' });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
      chatSession.getChatHistory.mockResolvedValue([
        {
          role: 'user',
          content: '入职材料怎么交',
          timestamp: candidateAt,
          source: 'MOBILE_PUSH',
          messageType: 'TEXT',
          isSelf: false,
        },
        {
          role: 'assistant',
          content: '我来帮你处理',
          timestamp: candidateAt + 1_000,
          source: 'MOBILE_PUSH',
          messageType: 'TEXT',
          isSelf: true,
        },
      ]);

      await buildProcessor().process(onboardingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'human_intervention_after_candidate',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('keeps the pending-candidate-message gate for the onboarding touch', async () => {
      const candidateAt = Date.now() - 30 * 60_000;
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '面试成功' });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
      chatSession.getChatHistory.mockImplementation(
        (_chatId: string, limit: number) =>
          Promise.resolve(
            limit === 200
              ? []
              : [{ role: 'user', content: '我还有个问题', timestamp: candidateAt }],
          ),
      );
      messageProcessing.getLatestReceivedAtByChatId.mockResolvedValue(candidateAt - 10 * 60_000);

      await buildProcessor().process(onboardingJob());

      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'pending_candidate_message',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('schedules the +48h check only after markSent succeeds', async () => {
      const sentAt = Date.UTC(2026, 7, 20, 2, 0, 0);
      jest.spyOn(Date, 'now').mockReturnValue(sentAt);
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '面试成功' });
      session.getReengagementState.mockResolvedValue(baseState({ terminal: 'booked' }));
      systemConfig.getAgentReplyConfig.mockResolvedValue({
        reengagementEnabled: true,
        reengagementShadow: false,
        reengagementScenarioRollout: { post_interview_onboarding: true },
      });

      await buildProcessor().process(onboardingJob());

      expect(touchLedger.markSent).toHaveBeenCalled();
      expect(scheduler.scheduleOnboardingCheck).toHaveBeenCalledWith({
        sessionRef,
        workOrderId: 901,
        anchorAt: sentAt,
        channelIdentity: expect.objectContaining({ botImId: 'bot-1' }),
      });
      expect(touchLedger.markSent.mock.invocationCallOrder[0]).toBeLessThan(
        scheduler.scheduleOnboardingCheck.mock.invocationCallOrder[0],
      );
    });

    it('ends the +48h check silently after the work order reaches onboarding success', async () => {
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '上岗成功' });

      await buildProcessor().process(onboardingJob({ onboardingCheck: true }));

      expect(tracking.trackStopped).toHaveBeenCalledWith(expect.anything(), 'already_onboarded');
      expect(handoffRecorder.record).not.toHaveBeenCalled();
      expect(handoffNotifier.notify).not.toHaveBeenCalled();
      expect(session.getReengagementState).not.toHaveBeenCalled();
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('dispatches a non-pausing handoff when the +48h check is still not onboarded', async () => {
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '面试成功' });

      await buildProcessor().process(onboardingJob({ onboardingCheck: true }));

      expect(handoffRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'onboarding_follow_up_required',
          workOrderId: 901,
          idempotencyKey:
            'sess-1:post_interview_onboarding:wo901:onboarding_follow_up_required',
        }),
      );
      expect(handoffNotifier.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'onboarding_follow_up_required',
          diagnostics: expect.objectContaining({ hostingPaused: false }),
        }),
      );
      expect(tracking.trackStopped).toHaveBeenCalledWith(
        expect.anything(),
        'onboarding_intervention_dispatched',
      );
      expect(reengagementAgent.compose).not.toHaveBeenCalled();
    });

    it('uses the handoff write outcome to suppress duplicate notifications for one work order', async () => {
      sponge.getWorkOrderById.mockResolvedValue({ workOrderId: 901, currentStatus: '上岗失败' });
      handoffRecorder.record.mockResolvedValueOnce('inserted').mockResolvedValueOnce('duplicate');

      await buildProcessor().process(onboardingJob());
      await buildProcessor().process(onboardingJob());

      expect(handoffRecorder.record).toHaveBeenCalledTimes(2);
      expect(handoffNotifier.notify).toHaveBeenCalledTimes(1);
      expect(handoffRecorder.record).toHaveBeenCalledWith(
        expect.objectContaining({
          reasonCode: 'onboarding_failed',
          idempotencyKey: 'sess-1:post_interview_onboarding:wo901:onboarding_failed',
        }),
      );
    });
  });
});
