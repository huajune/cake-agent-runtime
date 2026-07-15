import { ReplyWorkflowService } from '@channels/wecom/message/application/reply-workflow.service';
import { EnterpriseMessageCallbackDto } from '@channels/wecom/message/ingress/message-callback.dto';
import { ContactType, MessageSource, MessageType } from '@enums/message-callback.enum';
import { CallerKind } from '@enums/agent.enum';
import { ReengagementAnchorService } from '@agent/reengagement/anchor.service';
import type { GeneratorInvokeParams } from '@agent/generator/generator.types';
import type { SessionRef, TurnRequest, TurnTrigger } from '@agent/runner/agent-runner.types';
import { classifyReviewedOutcome } from '@agent/runner/turn-outcome';
import { TurnFinalizer } from '@agent/runner/turn-finalizer';
import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';

describe('ReplyWorkflowService', () => {
  const deduplicationService = {
    markMessageAsProcessedAsync: jest.fn(),
  };
  const deliveryService = {
    deliverReply: jest.fn(),
  };
  const runner = {
    invoke: jest.fn(),
    invokeReviewed: jest.fn(),
    invokeReviewedTurn: jest.fn(),
    runTurn: jest.fn(),
    precheckInboundOutcome: jest.fn(),
  };
  // 出站守卫裁决（reply-workflow 读 result.outputDecision）；默认 pass，个别用例改写。
  type OutputDecisionLike = {
    decision: 'pass' | 'revise' | 'block';
    riskLevel: 'low' | 'medium' | 'high';
    violations: unknown[];
    ruleIds: string[];
    blockedRuleIds: string[];
    reasonCode?: string;
  };
  const passOutputDecision: OutputDecisionLike = {
    decision: 'pass',
    riskLevel: 'low',
    violations: [],
    ruleIds: [],
    blockedRuleIds: [],
  };
  let currentOutputDecision: OutputDecisionLike = passOutputDecision;
  type RunTurnMockParams = TurnRequest;
  const monitoringService = {
    recordSuccess: jest.fn(),
  };
  const wecomObservability = {
    hasTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    mergePrepTimingsFromSources: jest.fn(),
    updateDispatch: jest.fn(),
    markWorkerStart: jest.fn(),
    markAiStart: jest.fn(),
    recordAgentRequest: jest.fn(),
    recordAgentResult: jest.fn(),
    updateRequestMessages: jest.fn(),
    markAiEnd: jest.fn(),
    markReplySkipped: jest.fn(),
    buildSuccessMetadata: jest.fn(),
    buildMergedRequestContent: jest.fn(),
  };
  const runtimeConfig = {
    resolveWecomChatModelSelection: jest.fn(),
    getMergeDelayMs: jest.fn(),
  };
  const processingFailureService = {
    inferErrorType: jest.fn(),
    handleProcessingError: jest.fn(),
    sendFallbackAlert: jest.fn(),
  };
  const simpleMergeService = {
    claimPendingSnapshot: jest.fn(),
    ackPendingMessages: jest.fn().mockResolvedValue(undefined),
  };
  const imageDescription = {
    describeAndUpdateAsync: jest.fn(),
    awaitVision: jest.fn().mockResolvedValue(undefined),
  };
  const imageBrandBackfill = {
    detectMissingImages: jest.fn().mockReturnValue([]),
    scheduleBackfill: jest.fn(),
  };
  const opsEventsRecorder = {
    recordEvent: jest.fn(),
    recordEventDetailed: jest.fn(),
  };
  const interventionService = {
    dispatch: jest.fn(),
  };
  const handoffRecorder = {
    record: jest.fn(),
  };
  const followUpScheduler = {
    scheduleFollowUp: jest.fn(),
    scheduleBookingResolution: jest.fn(),
    removePendingJob: jest.fn(),
    removeSupersededPendingJobs: jest.fn(),
  };
  const session = {
    saveTerminalState: jest.fn(),
    recordCandidateActivity: jest.fn(),
  };
  const alertNotifier = {
    sendSimpleAlert: jest.fn().mockResolvedValue(true),
  };

  let service: ReplyWorkflowService;

  beforeEach(() => {
    jest.clearAllMocks();
    // invokeReviewedTurn 委托给 invoke（保留既有 runner.invoke 断言），并叠加统一 outcome/finalizer。
    currentOutputDecision = passOutputDecision;
    runner.invokeReviewed.mockImplementation(async (params: GeneratorInvokeParams) => {
      const raw = await runner.invoke(params);
      return {
        ...raw,
        outputDecision: raw.outputDecision ?? currentOutputDecision,
        revised: raw.revised ?? false,
      };
    });
    type ReviewedTurnMockParams = {
      invoke: GeneratorInvokeParams;
      trigger: TurnTrigger;
      sessionRef: SessionRef;
      messageId?: string;
      onTurnEndError?: (error: unknown) => void;
    };
    runner.invokeReviewedTurn.mockImplementation(async (params: ReviewedTurnMockParams) => {
      const raw = await runner.invoke(params.invoke);
      const reviewed = {
        ...raw,
        outputDecision: raw.outputDecision ?? currentOutputDecision,
        revised: raw.revised ?? false,
      };
      const outcome =
        raw.outcome ??
        classifyReviewedOutcome(reviewed, params.trigger, params.sessionRef, params.messageId);
      return {
        ...reviewed,
        runTurnEnd: undefined,
        outcome: { ...outcome, runTurnEnd: undefined },
        turnFinalizer:
          raw.turnFinalizer ?? TurnFinalizer.from(raw.runTurnEnd, params.onTurnEndError),
      };
    });
    runner.runTurn.mockImplementation(async (req: RunTurnMockParams) => {
      const invokeParams: GeneratorInvokeParams = {
        callerKind: req.context?.callerKind ?? CallerKind.WECOM,
        userId: req.sessionRef.userId,
        corpId: req.sessionRef.corpId,
        sessionId: req.sessionRef.sessionId,
        messageId: req.context?.messageId,
        messages:
          req.trigger.kind === 'inbound'
            ? [
                {
                  role: 'user',
                  content: req.trigger.userMessage,
                  imageUrls: req.trigger.images,
                  imageMessageIds: req.context?.imageMessageIds,
                },
              ]
            : [{ role: 'user', content: '[系统主动跟进]' }],
        toolMode: req.toolMode ?? (req.trigger.kind === 'proactive' ? 'readonly' : 'scenario'),
        proactiveDirective: req.trigger.kind === 'proactive' ? req.trigger.directive : undefined,
        deferTurnEnd: true,
        scenario: req.context?.scenario,
        imageUrls: req.trigger.kind === 'inbound' ? req.trigger.images : undefined,
        imageMessageIds: req.context?.imageMessageIds,
        visualMessageTypes: req.context?.visualMessageTypes,
        contactName: req.context?.contactName,
        botImId: req.context?.botImId,
        botUserId: req.context?.botUserId,
        groupId: req.context?.groupId,
        externalUserId: req.context?.externalUserId,
        token: req.context?.token,
        imContactId: req.context?.imContactId,
        imRoomId: req.context?.imRoomId,
        apiType: req.context?.apiType,
        modelId: req.modelId,
        thinking: req.context?.thinking,
        shortTermEndTimeInclusive: req.context?.shortTermEndTimeInclusive,
        onPreparedRequest: req.context?.onPreparedRequest,
      };
      const raw = await runner.invoke(invokeParams);
      const reviewed = {
        ...raw,
        outputDecision: raw.outputDecision ?? currentOutputDecision,
        revised: raw.revised ?? false,
      };
      const outcome =
        raw.outcome ??
        classifyReviewedOutcome(reviewed, req.trigger, req.sessionRef, req.context?.messageId);
      return outcome;
    });
    deduplicationService.markMessageAsProcessedAsync.mockResolvedValue(undefined);
    deliveryService.deliverReply.mockResolvedValue({
      success: true,
      segmentCount: 1,
      failedSegments: 0,
      totalTime: 120,
    });
    runner.invoke.mockResolvedValue({
      text: '我来帮你看一下',
      reasoning: 'checked',
      responseMessages: [
        {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'checked' },
            { type: 'text', text: '我来帮你看一下' },
          ],
        },
      ],
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    });
    wecomObservability.hasTrace.mockResolvedValue(false);
    wecomObservability.startRequestTrace.mockResolvedValue(undefined);
    wecomObservability.mergePrepTimingsFromSources.mockResolvedValue(undefined);
    wecomObservability.updateDispatch.mockResolvedValue(undefined);
    wecomObservability.markWorkerStart.mockResolvedValue(undefined);
    wecomObservability.markAiStart.mockResolvedValue(undefined);
    wecomObservability.recordAgentRequest.mockResolvedValue(undefined);
    wecomObservability.recordAgentResult.mockResolvedValue(undefined);
    wecomObservability.updateRequestMessages.mockResolvedValue(undefined);
    wecomObservability.markAiEnd.mockResolvedValue(undefined);
    wecomObservability.markReplySkipped.mockResolvedValue(undefined);
    wecomObservability.buildSuccessMetadata.mockResolvedValue({ ok: true });
    wecomObservability.buildMergedRequestContent.mockImplementation(
      (messages: EnterpriseMessageCallbackDto[]) =>
        messages
          .map((m) => {
            const payload = m.payload as { text?: string; pureText?: string } | undefined;
            return payload?.pureText ?? payload?.text ?? '';
          })
          .join('\n'),
    );
    simpleMergeService.claimPendingSnapshot.mockResolvedValue({
      messages: [],
      snapshotSize: 0,
      batchId: '',
    });
    runtimeConfig.resolveWecomChatModelSelection.mockResolvedValue({
      overrideModelId: 'gpt-runtime',
      thinkingMode: 'deep',
      thinking: {
        type: 'enabled',
        budgetTokens: 4000,
      },
    });
    runtimeConfig.getMergeDelayMs.mockReturnValue(3500);
    processingFailureService.inferErrorType.mockReturnValue('message');
    processingFailureService.handleProcessingError.mockResolvedValue(undefined);
    runner.precheckInboundOutcome.mockResolvedValue(null);

    opsEventsRecorder.recordEvent.mockResolvedValue(true);
    opsEventsRecorder.recordEventDetailed.mockResolvedValue('inserted');
    followUpScheduler.scheduleFollowUp.mockResolvedValue({ scheduled: true });
    followUpScheduler.scheduleBookingResolution.mockResolvedValue({ scheduled: true });
    followUpScheduler.removePendingJob.mockResolvedValue(true);
    followUpScheduler.removeSupersededPendingJobs.mockResolvedValue(1);
    session.saveTerminalState.mockResolvedValue(undefined);
    session.recordCandidateActivity.mockResolvedValue(undefined);
    interventionService.dispatch.mockResolvedValue({
      dispatched: true,
      paused: true,
      alerted: true,
    });
    handoffRecorder.record.mockResolvedValue('inserted');

    const reengagementAnchors = new ReengagementAnchorService(
      followUpScheduler as never,
      session as never,
    );
    const outcomeInterventions = new TurnOutcomeInterventionService(
      interventionService as never,
      handoffRecorder as never,
    );

    service = new ReplyWorkflowService(
      deduplicationService as never,
      deliveryService as never,
      runner as never,
      monitoringService as never,
      wecomObservability as never,
      runtimeConfig as never,
      processingFailureService as never,
      simpleMergeService as never,
      imageDescription as never,
      opsEventsRecorder as never,
      outcomeInterventions as never,
      followUpScheduler as never,
      reengagementAnchors,
      alertNotifier as never,
      imageBrandBackfill as never,
    );
  });

  it('should execute the direct reply workflow and mark the message as processed', async () => {
    const message = createMessage();

    await service.processSingleMessage(message);

    expect(wecomObservability.startRequestTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: 'msg-1',
        content: '你好',
      }),
    );
    expect(runner.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'chat-1',
        userId: 'im-contact-1',
        corpId: 'corp-1',
        externalUserId: 'external-user-1',
        modelId: 'gpt-runtime',
        shortTermEndTimeInclusive: 1713168000000,
        thinking: {
          type: 'enabled',
          budgetTokens: 4000,
        },
      }),
    );
    expect(deliveryService.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '我来帮你看一下',
      }),
      expect.objectContaining({
        chatId: 'chat-1',
        messageId: 'msg-1',
      }),
      true,
    );
    expect(wecomObservability.recordAgentResult).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({
        responseMessages: [
          expect.objectContaining({
            role: 'assistant',
          }),
        ],
      }),
    );
    expect(monitoringService.recordSuccess).toHaveBeenCalledWith('msg-1', { ok: true });
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
  });

  it('does not freeze callback token or api type into reengagement identities', async () => {
    await service.processSingleMessage(createMessage({ token: 'enterprise-callback-token' }));
    await flush();

    const openingCall = followUpScheduler.scheduleFollowUp.mock.calls.find(
      ([input]) => input.scenarioCode === 'opening_no_reply',
    );
    expect(openingCall?.[0].channelIdentity).toEqual(
      expect.objectContaining({
        botImId: 'im-bot-1',
        imContactId: 'im-contact-1',
      }),
    );
    expect(openingCall?.[0].channelIdentity).not.toHaveProperty('token');
    expect(openingCall?.[0].channelIdentity).not.toHaveProperty('apiType');
  });

  it('should pass image urls to Agent directly without pre-describing on successful multimodal path', async () => {
    const message = createMessage({
      messageType: MessageType.IMAGE,
      payload: {
        imageUrl: 'https://example.com/job-card.jpg',
        artworkUrl: 'https://example.com/original-job-card.jpg',
      },
    });

    await service.processSingleMessage(message);

    expect(runner.invoke).toHaveBeenCalledTimes(1);
    expect(runner.invoke.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        imageUrls: ['https://example.com/original-job-card.jpg'],
        imageMessageIds: ['msg-1'],
        messages: [
          expect.objectContaining({
            role: 'user',
            content: '[图片消息]',
            imageUrls: ['https://example.com/original-job-card.jpg'],
            imageMessageIds: ['msg-1'],
          }),
        ],
      }),
    );
    expect(imageDescription.describeAndUpdateAsync).not.toHaveBeenCalled();
  });

  it('should describe images and retry text-only when multimodal Agent call fails', async () => {
    const message = createMessage({
      messageType: MessageType.IMAGE,
      payload: {
        imageUrl: 'https://example.com/job-card.jpg',
        artworkUrl: 'https://example.com/original-job-card.jpg',
      },
    });
    runner.invoke.mockRejectedValueOnce(new Error('vision provider failed')).mockResolvedValueOnce({
      text: '文本兼容重跑成功',
      reasoning: undefined,
      responseMessages: [],
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
    });

    await service.processSingleMessage(message);

    expect(imageDescription.describeAndUpdateAsync).toHaveBeenCalledWith(
      'msg-1',
      'https://example.com/original-job-card.jpg',
      MessageType.IMAGE,
    );
    expect(imageDescription.awaitVision).toHaveBeenCalledWith(['msg-1'], 15_000);
    expect(runner.invoke).toHaveBeenCalledTimes(2);
    expect(runner.invoke.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        imageUrls: ['https://example.com/original-job-card.jpg'],
        imageMessageIds: ['msg-1'],
      }),
    );
    expect(runner.invoke.mock.calls[1][0]).toEqual(
      expect.objectContaining({
        imageUrls: undefined,
        imageMessageIds: undefined,
        visualMessageTypes: undefined,
      }),
    );
    expect(deliveryService.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '文本兼容重跑成功' }),
      expect.anything(),
      true,
    );
  });

  it('should persist empty Agent telemetry before delegating failure handling', async () => {
    const agentSteps = [
      {
        stepIndex: 0,
        reasoning: '工具执行后没有最终文本',
        toolCalls: [
          {
            toolName: 'duliday_interview_precheck',
            args: { jobId: 522935, requestedDate: 'today' },
            result: { success: true },
            status: 'unknown',
          },
        ],
        finishReason: 'stop',
      },
    ];
    runner.invoke.mockResolvedValueOnce({
      text: '',
      reasoning: '只有 thinking，没有回复文本',
      responseMessages: [{ role: 'assistant', content: [{ type: 'reasoning', text: '...' }] }],
      toolCalls: agentSteps[0].toolCalls,
      agentSteps,
      usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 },
    });

    await service.processSingleMessage(createMessage());

    expect(wecomObservability.recordAgentResult).toHaveBeenCalledWith(
      'msg-1',
      expect.objectContaining({
        reply: expect.objectContaining({ content: '' }),
        toolCalls: agentSteps[0].toolCalls,
        agentSteps,
        responseMessages: [{ role: 'assistant', content: [{ type: 'reasoning', text: '...' }] }],
      }),
    );
    expect(processingFailureService.inferErrorType).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Agent 返回空响应',
        isAgentError: true,
        agentMeta: expect.objectContaining({
          lastCategory: 'empty_response',
        }),
      }),
      'message',
    );
    expect(processingFailureService.handleProcessingError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'Agent 返回空响应',
      }),
      expect.anything(),
      expect.objectContaining({
        dispatchMode: 'direct',
        traceId: 'msg-1',
      }),
    );
    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
  });

  it('request_handoff 正常短路（shortCircuited:true）→ 跳过发送', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '',
      reasoning: undefined,
      responseMessages: [],
      toolCalls: [
        {
          toolName: 'request_handoff',
          args: { reasonCode: 'onboarding_paperwork', reason: '候选人办入职' },
          result: { dispatched: true, shortCircuited: true },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    });

    await service.processSingleMessage(createMessage());

    expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
  });

  it('runtime gate 短路（任意工具 shortCircuited:true）→ 跳过发送', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '',
      reasoning: undefined,
      responseMessages: [],
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 100 },
          result: {
            success: false,
            shortCircuited: true,
            gateRejected: true,
            reasonCode: 'job_id_not_recalled',
          },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    });

    await service.processSingleMessage(createMessage());

    expect(handoffRecorder.record).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        chatId: 'chat-1',
        userId: 'im-contact-1',
        reasonCode: 'system_blocked',
        reason: expect.stringContaining('job_id_not_recalled'),
        idempotencyKey: 'chat-1:handoff:msg-1',
      }),
    );
    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'general_handoff',
        alertLabel: 'Booking runtime guard 拦截',
        chatId: 'chat-1',
        pauseTargetId: 'chat-1',
        reason: expect.stringContaining('job_id_not_recalled'),
      }),
    );
    expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
    expect(processingFailureService.handleProcessingError).not.toHaveBeenCalled();
  });

  it('runtime gate handoff duplicate → skips repeated dispatch but still skips reply', async () => {
    handoffRecorder.record.mockResolvedValueOnce('duplicate');
    runner.invoke.mockResolvedValueOnce({
      text: '',
      reasoning: undefined,
      responseMessages: [],
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 100 },
          result: {
            success: false,
            shortCircuited: true,
            gateRejected: true,
            reasonCode: 'job_id_not_recalled',
          },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
    });

    await service.processSingleMessage(createMessage());

    expect(handoffRecorder.record).toHaveBeenCalled();
    expect(interventionService.dispatch).not.toHaveBeenCalled();
    expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
  });

  it('request_handoff(HANDOFF_NO_BOOKING, shortCircuited:false) → 不短路，正常投递 Agent 继续生成的回复（回归 Finding 1）', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '你还没有已确认的面试预约，我先帮你约首次面试哈',
      reasoning: undefined,
      responseMessages: [],
      toolCalls: [
        {
          toolName: 'request_handoff',
          args: { reasonCode: 'modify_appointment', reason: '候选人要改期但无预约' },
          // HANDOFF_NO_BOOKING：工具返回 shortCircuited:false（不短路），Agent 已按首次约面继续生成回复
          result: { dispatched: false, errorType: 'handoff.no_booking', shortCircuited: false },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 5, totalTokens: 6 },
    });

    await service.processSingleMessage(createMessage());

    expect(wecomObservability.markReplySkipped).not.toHaveBeenCalled();
    expect(deliveryService.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '你还没有已确认的面试预约，我先帮你约首次面试哈' }),
      expect.anything(),
      true,
    );
    expect(session.saveTerminalState).not.toHaveBeenCalled();
  });

  it('reply outcome 携带风险 sideEffect → 先投递安抚回复，再等待介入落地', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '我理解你的着急，我这边先帮你确认一下情况。',
      reasoning: undefined,
      responseMessages: [],
      toolCalls: [
        {
          toolName: 'raise_risk_alert',
          args: { riskType: 'escalation', reason: '候选人连续催促' },
          result: {
            accepted: true,
            sideEffect: {
              kind: 'conversation_risk',
              source: 'agent_tool',
              riskType: 'escalation',
              riskLabel: '情绪升级',
              summary: '候选人连续催促',
              reason: '候选人连续催促',
              currentMessageContent: '怎么还不回',
              recentMessages: [],
              sessionState: null,
            },
          },
        },
      ],
      usage: { inputTokens: 1, outputTokens: 5, totalTokens: 6 },
    });

    await service.processSingleMessage(createMessage());

    expect(deliveryService.deliverReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '我理解你的着急，我这边先帮你确认一下情况。' }),
      expect.anything(),
      true,
    );
    expect(interventionService.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'conversation_risk',
        source: 'agent_tool',
        riskType: 'escalation',
      }),
    );
    expect(deliveryService.deliverReply.mock.invocationCallOrder[0]).toBeLessThan(
      interventionService.dispatch.mock.invocationCallOrder[0],
    );
    expect(interventionService.dispatch.mock.invocationCallOrder[0]).toBeLessThan(
      deduplicationService.markMessageAsProcessedAsync.mock.invocationCallOrder[0],
    );
  });

  it('schedules booking_incomplete follow-up when accepted precheck still needs fields', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '还差学历，补一下我帮你约',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolName: 'duliday_interview_precheck',
          args: { jobId: 100 },
          result: {
            success: true,
            nextAction: 'collect_fields',
            bookingChecklist: { missingFields: ['学历'] },
          },
        },
      ],
    });

    await service.processSingleMessage(createMessage());

    expect(followUpScheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: { corpId: 'corp-1', userId: 'im-contact-1', sessionId: 'chat-1' },
        scenarioCode: 'booking_incomplete',
        anchorEventId: 'msg-1:collection_started',
      }),
    );
  });

  it('schedules Sponge resolution jobs when booking succeeds', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '约好了，明天 13:30 面试',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 100, interviewTime: '2026-06-27 13:30:00' },
          result: {
            success: true,
            workOrderId: 123,
            errorType: null,
          },
        },
      ],
    });

    await service.processSingleMessage(createMessage());
    await flush();

    expect(followUpScheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: { corpId: 'corp-1', userId: 'im-contact-1', sessionId: 'chat-1' },
        scenarioCode: 'interview_reminder',
        anchorEventId: 'msg-1:booking_succeeded:interview_reminder',
        workOrderId: 123,
      }),
    );
    expect(followUpScheduler.scheduleBookingResolution).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: { corpId: 'corp-1', userId: 'im-contact-1', sessionId: 'chat-1' },
        scenarioCode: 'post_interview_followup',
        anchorEventId: 'msg-1:booking_succeeded:post_interview_followup',
        workOrderId: 123,
      }),
    );
    const payload = JSON.stringify(followUpScheduler.scheduleBookingResolution.mock.calls);
    expect(payload).not.toContain('expectedInterviewAt');
    expect(payload).not.toContain('interviewTime');
    expect(session.saveTerminalState).toHaveBeenCalledWith(
      'corp-1',
      'im-contact-1',
      'chat-1',
      'booked',
    );
  });

  it('does not schedule post-booking follow-ups when booking succeeds without interview time', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '报名成功，面试官会电话联系你',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 100 },
          result: {
            success: true,
            workOrderId: 123,
            errorType: null,
          },
        },
      ],
    });

    await service.processSingleMessage(createMessage());

    expect(followUpScheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'interview_reminder' }),
    );
    expect(followUpScheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'post_interview_followup' }),
    );
    expect(session.saveTerminalState).toHaveBeenCalledWith(
      'corp-1',
      'im-contact-1',
      'chat-1',
      'booked',
    );
  });

  it('schedules store_presented_no_reply after a delivered job recommendation reply', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '杨浦奥乐齐长白店有分拣打包岗位，薪资 25 元/时。',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolName: 'duliday_job_list',
          args: {},
          result: {
            resultCount: 1,
            markdown: '## 1. 分拣打包\n**品牌**: 奥乐齐\n**门店**: 长白店',
          },
        },
      ],
    });

    await service.processSingleMessage(createMessage());

    expect(followUpScheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: { corpId: 'corp-1', userId: 'im-contact-1', sessionId: 'chat-1' },
        scenarioCode: 'store_presented_no_reply',
        anchorEventId: 'msg-1:store_presented',
      }),
    );
  });

  it('schedules address_missing after a delivered reply asks for location', async () => {
    opsEventsRecorder.recordEventDetailed.mockResolvedValueOnce('duplicate');
    runner.invoke.mockResolvedValueOnce({
      text: '你可以发个位置，我帮你看附近合适的门店。',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });

    await service.processSingleMessage(createMessage());

    expect(followUpScheduler.scheduleFollowUp).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionRef: { corpId: 'corp-1', userId: 'im-contact-1', sessionId: 'chat-1' },
        scenarioCode: 'address_missing',
        anchorEventId: 'msg-1:address_missing',
      }),
    );
  });

  it('does not schedule delivered-reply follow-ups when delivery is skipped', async () => {
    runner.invoke.mockResolvedValueOnce({
      text: '你可以发个位置，我帮你看附近合适的门店。',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [],
    });
    deliveryService.deliverReply.mockResolvedValueOnce({
      success: true,
      segmentCount: 0,
      failedSegments: 0,
      deliveredSegments: 0,
      totalTime: 1,
      skipped: true,
      skipReason: 'hosting_paused',
    });

    await service.processSingleMessage(createMessage());

    expect(opsEventsRecorder.recordEventDetailed).not.toHaveBeenCalled();
    expect(followUpScheduler.scheduleFollowUp).not.toHaveBeenCalled();
  });

  it('出站守卫 block（歧视性筛选条件外露）→ 拦截回复不投递，仍完成本轮流水', async () => {
    currentOutputDecision = {
      decision: 'block',
      riskLevel: 'high',
      violations: [],
      ruleIds: ['discriminatory_screening_leak'],
      blockedRuleIds: ['discriminatory_screening_leak'],
    };

    await service.processSingleMessage(createMessage());

    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
    expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
    expect(monitoringService.recordSuccess).toHaveBeenCalled();
    expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
  });

  describe('turn-end 投影闸门（仅真实送达才写助手轮次）', () => {
    it('回复真实投递 → turn-end 投影助手轮次（includeAssistantText:true）', async () => {
      const runTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '我来帮你看一下',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        toolCalls: [],
        runTurnEnd,
      });

      await service.processSingleMessage(createMessage());

      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: true });
    });

    it('投递因托管暂停被丢弃 → turn-end 不投影助手轮次（includeAssistantText:false）', async () => {
      const runTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '你可以发个位置，我帮你看附近门店。',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
        runTurnEnd,
      });
      deliveryService.deliverReply.mockResolvedValueOnce({
        success: true,
        segmentCount: 0,
        failedSegments: 0,
        deliveredSegments: 0,
        totalTime: 1,
        skipped: true,
        skipReason: 'hosting_paused',
      });

      await service.processSingleMessage(createMessage());

      expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
    });

    it('出站守卫拦截 → turn-end 只记用户侧（includeAssistantText:false），不投递', async () => {
      currentOutputDecision = {
        decision: 'block',
        riskLevel: 'high',
        violations: [],
        ruleIds: ['discriminatory_screening_leak'],
        blockedRuleIds: ['discriminatory_screening_leak'],
      };
      const runTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '被拦截的回复',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
        runTurnEnd,
      });

      await service.processSingleMessage(createMessage());

      expect(deliveryService.deliverReply).not.toHaveBeenCalled();
      expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
    });

    it('投递抛异常 → 仍以 includeAssistantText:false 完成用户侧 turn-end（事实提取不丢）', async () => {
      const runTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '好的，帮你约明天下午',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
        runTurnEnd,
      });
      deliveryService.deliverReply.mockRejectedValueOnce(new Error('WeCom send 5xx'));

      await service.processSingleMessage(createMessage());

      expect(runTurnEnd).toHaveBeenCalledTimes(1);
      expect(runTurnEnd).toHaveBeenCalledWith({ includeAssistantText: false });
    });
  });

  describe('前置风险预检命中 → 确定性静默 + 暂停', () => {
    it('命中即跳过 Agent 与投递，仍标记已处理与跳过观测', async () => {
      simpleMergeService.claimPendingSnapshot.mockResolvedValueOnce({
        messages: [
          createMessage({
            messageId: 'msg-late-risk',
            payload: { text: '后补一句', pureText: '后补一句' },
          }),
        ],
        snapshotSize: 1,
        batchId: 'batch-late',
      });
      runner.runTurn.mockResolvedValueOnce({
        kind: 'guardrail_blocked',
        toolCalls: [],
        disposition: 'side_effects',
        guardrail: {
          phase: 'inbound',
          source: 'input_guardrail',
          riskType: 'abuse',
          riskLabel: '辱骂',
          reason: '命中辱骂关键词',
          inspectedText: '你们就是骗子',
        },
        sideEffects: [
          {
            kind: 'conversation_risk',
            source: 'regex_intercept',
            riskType: 'abuse',
            riskLabel: '辱骂',
            summary: '候选人消息命中高置信度风险关键词',
            reason: '命中辱骂关键词',
            currentMessageContent: '你们就是骗子',
            recentMessages: [],
            sessionState: null,
          },
        ],
      });

      await service.processSingleMessage(createMessage());

      expect(runner.invoke).not.toHaveBeenCalled();
      expect(runner.precheckInboundOutcome).not.toHaveBeenCalled();
      expect(simpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
      expect(deliveryService.deliverReply).not.toHaveBeenCalled();
      expect(interventionService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'conversation_risk',
          source: 'regex_intercept',
          riskType: 'abuse',
          chatId: 'chat-1',
          pauseTargetId: 'chat-1',
        }),
      );
      expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
      expect(monitoringService.recordSuccess).toHaveBeenCalledWith('msg-1', { ok: true });
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
      expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalledWith(
        'msg-late-risk',
      );
    });
  });

  describe('出站拦截 → 转人工兜底', () => {
    it('llm/降级 block（无 blockedRuleIds）→ dispatch general_handoff + 写 handoff 底账', async () => {
      currentOutputDecision = {
        decision: 'block',
        riskLevel: 'high',
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
        reasonCode: 'output_review_unavailable',
      };
      runner.invoke.mockResolvedValueOnce({
        text: '未经审定的高风险回复',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
      });

      await service.processSingleMessage(createMessage());

      expect(deliveryService.deliverReply).not.toHaveBeenCalled();
      expect(handoffRecorder.record).toHaveBeenCalledTimes(1);
      expect(interventionService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'general_handoff', source: 'agent_tool' }),
      );
    });

    it('rule 档 block → 不投递 + dispatch general_handoff + 写 handoff 底账', async () => {
      currentOutputDecision = {
        decision: 'block',
        riskLevel: 'high',
        violations: [],
        ruleIds: ['discriminatory_screening_leak'],
        blockedRuleIds: ['discriminatory_screening_leak'],
      };
      runner.invoke.mockResolvedValueOnce({
        text: '命中 rule 档的回复',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        toolCalls: [],
      });

      await service.processSingleMessage(createMessage());

      expect(deliveryService.deliverReply).not.toHaveBeenCalled();
      expect(handoffRecorder.record).toHaveBeenCalledTimes(1);
      expect(interventionService.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'general_handoff',
          source: 'agent_tool',
          alertLabel: '出站守卫拦截（rule 档）',
        }),
      );
    });
  });

  it('booking succeeds but output is blocked → persists booked terminal without scheduling reminders', async () => {
    currentOutputDecision = {
      decision: 'block',
      riskLevel: 'high',
      violations: [],
      ruleIds: ['proactive_insurance_policy_mention'],
      blockedRuleIds: ['proactive_insurance_policy_mention'],
    };
    runner.invoke.mockResolvedValueOnce({
      text: '约好了，另外这个有五险',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      toolCalls: [
        {
          toolName: 'duliday_interview_booking',
          args: { jobId: 100, interviewTime: '2026-06-27 13:30:00' },
          result: { success: true, workOrderId: 123 },
        },
      ],
    });

    await service.processSingleMessage(createMessage());

    expect(deliveryService.deliverReply).not.toHaveBeenCalled();
    expect(session.saveTerminalState).toHaveBeenCalledWith(
      'corp-1',
      'im-contact-1',
      'chat-1',
      'booked',
    );
    expect(followUpScheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'interview_reminder' }),
    );
    expect(followUpScheduler.scheduleFollowUp).not.toHaveBeenCalledWith(
      expect.objectContaining({ scenarioCode: 'post_interview_followup' }),
    );
  });

  it('出站守卫常规告警规则命中（decision=pass）→ 不拦截，正常投递', async () => {
    currentOutputDecision = {
      decision: 'pass',
      riskLevel: 'low',
      violations: [],
      ruleIds: ['group_promise_without_invite'],
      blockedRuleIds: [],
    };

    await service.processSingleMessage(createMessage());

    expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
    expect(wecomObservability.markReplySkipped).not.toHaveBeenCalled();
  });

  describe('投递前重跑（replay）', () => {
    it('Case A: pending list 为空时不触发重跑，直接投递首次回复并触发 turn-end 生命周期', async () => {
      const message = createMessage();
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '我来帮你看一下',
        reasoning: undefined,
        responseMessages: [],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: firstRunTurnEnd,
      });

      await service.processSingleMessage(message);

      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenCalledTimes(1);
      // singleMessage 路径上 consumedPending 起点是 0，replay 抓取时 fromIndex 也是 0
      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenCalledWith('chat-1', 0);
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      // 首次调用必须启用 deferTurnEnd，以便在检测到新消息时能丢弃首次的记忆副作用
      expect(runner.invoke.mock.calls[0][0]).toEqual(
        expect.objectContaining({ deferTurnEnd: true }),
      );
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      // 无 replay：首次结果被采纳，调用方必须触发 runTurnEnd
      expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
    });

    it('Case B: 首次 Agent 完成后发现新消息，合并后重跑一次并投递第二次回复', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        timestamp: '1713168001000',
        payload: { text: '补充一句', pureText: '补充一句' },
      });
      const late2 = createMessage({
        messageId: 'msg-late-2',
        timestamp: '1713168002000',
        payload: { text: '再补一句', pureText: '再补一句' },
      });
      simpleMergeService.claimPendingSnapshot.mockResolvedValueOnce({
        messages: [late1, late2],
        snapshotSize: 2,
        batchId: 'batch-late',
      });
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke
        .mockResolvedValueOnce({
          text: '首次回复（会被丢弃）',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          runTurnEnd: firstRunTurnEnd,
        })
        .mockResolvedValueOnce({
          text: '合并后的最终回复',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenCalledTimes(2);
      expect(runner.invoke).toHaveBeenCalledTimes(2);
      // 两次都启用 deferTurnEnd：本用例第二次生成后已无 pending，因此该结果被采纳，
      // 由 workflow 启动并在方法返回（处理锁释放）前 await，保证记忆写入相对锁串行。
      expect(runner.invoke.mock.calls[0][0]).toEqual(
        expect.objectContaining({
          deferTurnEnd: true,
          shortTermEndTimeInclusive: 1713168000000,
        }),
      );
      expect(runner.invoke.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          deferTurnEnd: true,
          shortTermEndTimeInclusive: 1713168002000,
        }),
      );
      // 首次的 runTurnEnd 必须被丢弃——它承载了「未发出的首次回复」对 session 记忆的污染
      expect(firstRunTurnEnd).not.toHaveBeenCalled();
      expect(runner.invoke.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          // 第二次 invoke 的 userMessage 应当是合并后的新内容
          messages: [
            expect.objectContaining({
              role: 'user',
              content: '你好\n补充一句\n再补一句',
            }),
          ],
        }),
      );
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '合并后的最终回复' }),
        expect.anything(),
        true,
      );
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-late-1');
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-late-2');
      // Replay 合入的新消息需要回收源流水，否则它们的 processing 行会永远孤儿
      expect(wecomObservability.mergePrepTimingsFromSources).toHaveBeenCalledWith('msg-1', [
        'msg-late-1',
        'msg-late-2',
      ]);
      expect(wecomObservability.updateRequestMessages).toHaveBeenCalledWith('msg-1', {
        messages: [primary, late1, late2],
        content: '你好\n补充一句\n再补一句',
        mergeWindowMs: 3500,
      });
    });

    it('Case C: 第一次 replay 期间又有新消息时继续合并，避免拆成重复感强的 follow-up', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        payload: { text: '第二条', pureText: '第二条' },
      });
      const late2 = createMessage({
        messageId: 'msg-late-2',
        payload: { text: '第三条', pureText: '第三条' },
      });

      simpleMergeService.claimPendingSnapshot
        .mockResolvedValueOnce({
          messages: [late1],
          snapshotSize: 1,
          batchId: 'batch-late-1',
        })
        .mockResolvedValueOnce({
          messages: [late2],
          snapshotSize: 1,
          batchId: 'batch-late-2',
        })
        .mockResolvedValueOnce({ messages: [], snapshotSize: 0, batchId: '' });

      runner.invoke
        .mockResolvedValueOnce({
          text: '首次回复（会被丢弃）',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })
        .mockResolvedValueOnce({
          text: '第一次 replay 回复（仍会被丢弃）',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        })
        .mockResolvedValueOnce({
          text: '吸收三条消息后的最终回复',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenNthCalledWith(1, 'chat-1', 0);
      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenNthCalledWith(2, 'chat-1', 1);
      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenNthCalledWith(3, 'chat-1', 2);
      expect(runner.invoke).toHaveBeenCalledTimes(3);
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '吸收三条消息后的最终回复' }),
        expect.anything(),
        true,
      );
      expect(runner.invoke.mock.calls[2][0]).toEqual(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: 'user',
              content: '你好\n第二条\n第三条',
            }),
          ],
        }),
      );
    });

    it.each([['invite_to_group'], ['duliday_interview_booking']])(
      'Case E: 首次调用命中不可逆工具 [%s] 时跳过 replay，不 drain pending，直接投递首次回复',
      async (blockingToolName) => {
        const primary = createMessage();
        // 即便 pending 有新消息，也不应该被 drain；这里故意准备新消息来验证 skip 语义
        simpleMergeService.claimPendingSnapshot.mockResolvedValue({
          messages: [
            createMessage({
              messageId: 'msg-late-irrev',
              payload: { text: '后补一句', pureText: '后补一句' },
            }),
          ],
          snapshotSize: 1,
          batchId: 'batch-late',
        });

        const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
        runner.invoke.mockResolvedValueOnce({
          text: '首次回复（必须投递）',
          reasoning: undefined,
          responseMessages: [],
          toolCalls: [{ toolName: blockingToolName, args: {} }],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          runTurnEnd: firstRunTurnEnd,
        });

        await service.processSingleMessage(primary);

        // 不 drain pending：新消息留给 MessageProcessor 的 checkAndProcessNewMessages 发起 follow-up job
        expect(simpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
        // 只调用一次 Agent；首次结果直接投递
        expect(runner.invoke).toHaveBeenCalledTimes(1);
        expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
        expect(deliveryService.deliverReply).toHaveBeenCalledWith(
          expect.objectContaining({ content: '首次回复（必须投递）' }),
          expect.anything(),
          true,
        );
        // 首次结果被采纳：必须显式触发 turn-end 生命周期（deferTurnEnd=true 的配套动作）
        expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
        // 只标记主消息已处理——后补的消息交给下一轮，不在本次 processedMessageIds 里
        expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
        expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalledWith(
          'msg-late-irrev',
        );
      },
    );

    it('Case E2: 首次只调用 advance_stage 时仍执行 replay，合并 Agent 生成期间的新消息', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-stage',
        timestamp: '1713168001000',
        payload: { text: '补充一个硬约束', pureText: '补充一个硬约束' },
      });
      simpleMergeService.claimPendingSnapshot.mockResolvedValueOnce({
        messages: [late1],
        snapshotSize: 1,
        batchId: 'batch-late',
      });
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke
        .mockResolvedValueOnce({
          text: '首次回复（会被丢弃）',
          reasoning: undefined,
          responseMessages: [],
          toolCalls: [{ toolName: 'advance_stage', args: {} }],
          usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
          runTurnEnd: firstRunTurnEnd,
        })
        .mockResolvedValueOnce({
          text: '合并新约束后的最终回复',
          reasoning: undefined,
          responseMessages: [],
          usage: { inputTokens: 4, outputTokens: 5, totalTokens: 9 },
        });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenCalledTimes(2);
      expect(runner.invoke).toHaveBeenCalledTimes(2);
      expect(firstRunTurnEnd).not.toHaveBeenCalled();
      expect(runner.invoke.mock.calls[1][0]).toEqual(
        expect.objectContaining({
          messages: [
            expect.objectContaining({
              role: 'user',
              content: '你好\n补充一个硬约束',
            }),
          ],
        }),
      );
      expect(deliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '合并新约束后的最终回复' }),
        expect.anything(),
        true,
      );
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith(
        'msg-late-stage',
      );
    });

    it('Case F: 首次命中不可逆工具 + 无副作用的其他工具，仍然按 skip 处理', async () => {
      const primary = createMessage();
      runner.invoke.mockResolvedValueOnce({
        text: '已为你安排预约',
        reasoning: undefined,
        responseMessages: [],
        toolCalls: [
          { toolName: 'duliday_job_list', args: {} },
          { toolName: 'duliday_interview_booking', args: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: jest.fn().mockResolvedValue(undefined),
      });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      expect(deliveryService.deliverReply).toHaveBeenCalledTimes(1);
    });

    it('Case G: 首次只调用无副作用的工具 → 按常规路径检查 pending，无新消息则直接投递首次', async () => {
      const primary = createMessage();
      const firstRunTurnEnd = jest.fn().mockResolvedValue(undefined);
      runner.invoke.mockResolvedValueOnce({
        text: '先问下你意向',
        reasoning: undefined,
        responseMessages: [],
        toolCalls: [
          { toolName: 'duliday_job_list', args: {} },
          { toolName: 'save_image_description', args: {} },
        ],
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
        runTurnEnd: firstRunTurnEnd,
      });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).toHaveBeenCalledTimes(1);
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      expect(firstRunTurnEnd).toHaveBeenCalledTimes(1);
    });

    it('Case D: 首次 skip_reply 是 Agent 终态 → 跳过 replay，新消息留到下一轮', async () => {
      const primary = createMessage();
      const late1 = createMessage({
        messageId: 'msg-late-1',
        payload: { text: '再问一下', pureText: '再问一下' },
      });
      simpleMergeService.claimPendingSnapshot.mockResolvedValueOnce({
        messages: [late1],
        snapshotSize: 1,
        batchId: 'batch-late',
      });
      runner.invoke.mockResolvedValueOnce({
        text: '',
        reasoning: undefined,
        responseMessages: [],
        toolCalls: [{ toolName: 'skip_reply', args: { reason: '候选人仅确认' } }],
        usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
      });

      await service.processSingleMessage(primary);

      expect(simpleMergeService.claimPendingSnapshot).not.toHaveBeenCalled();
      expect(runner.invoke).toHaveBeenCalledTimes(1);
      expect(wecomObservability.markReplySkipped).toHaveBeenCalledWith('msg-1');
      expect(deliveryService.deliverReply).not.toHaveBeenCalled();
      expect(deduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-1');
      expect(deduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalledWith(
        'msg-late-1',
      );
    });
  });

  it('should delegate merged-message failures and ack pending after terminal fallback handling', async () => {
    const error = new Error('agent boom');
    runner.invoke.mockRejectedValueOnce(error);
    processingFailureService.inferErrorType.mockReturnValueOnce('merge');

    const messages = [
      createMessage(),
      createMessage({
        messageId: 'msg-2',
        payload: {
          text: '第二条消息',
          pureText: '第二条消息',
        },
      }),
    ];

    await expect(service.processMergedMessages(messages, 'batch-1', messages.length)).resolves.toBe(
      undefined,
    );

    expect(processingFailureService.inferErrorType).toHaveBeenCalledWith(error, 'merge');
    expect(processingFailureService.handleProcessingError).toHaveBeenCalledWith(
      error,
      expect.objectContaining({
        messageId: 'msg-2',
      }),
      expect.objectContaining({
        traceId: 'batch-1',
        batchId: 'batch-1',
        dispatchMode: 'merged',
        processedMessageIds: ['msg-1', 'msg-2'],
      }),
    );
    expect(simpleMergeService.ackPendingMessages).toHaveBeenCalledWith('chat-1', messages.length);
  });
});

function createMessage(
  overrides: Partial<EnterpriseMessageCallbackDto> = {},
): EnterpriseMessageCallbackDto {
  return {
    orgId: 'corp-1',
    token: 'token-1',
    botId: 'bot-1',
    botUserId: 'manager-1',
    imBotId: 'im-bot-1',
    chatId: 'chat-1',
    imContactId: 'im-contact-1',
    messageType: MessageType.TEXT,
    messageId: 'msg-1',
    timestamp: '1713168000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: {
      text: '你好',
      pureText: '你好',
    },
    contactName: '张三',
    externalUserId: 'external-user-1',
    _apiType: 'enterprise',
    ...overrides,
  } as EnterpriseMessageCallbackDto;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
