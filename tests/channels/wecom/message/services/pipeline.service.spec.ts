import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { AcceptInboundMessageService } from '@wecom/message/application/accept-inbound-message.service';
import { ReplyWorkflowService } from '@wecom/message/application/reply-workflow.service';
import { MessageProcessingFailureService } from '@wecom/message/application/message-processing-failure.service';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { MessageRuntimeConfigService } from '@wecom/message/runtime/message-runtime-config.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { MessageFilterService } from '@wecom/message/application/filter.service';
import { MessageDeliveryService } from '@wecom/message/delivery/delivery.service';
import { ImageDescriptionService } from '@wecom/message/application/image-description.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { AgentRunnerService } from '@agent/runner/agent-runner.service';
import { TurnOutcomeInterventionService } from '@agent/runner/turn-outcome-intervention.service';
import { FollowUpSchedulerService } from '@agent/reengagement/follow-up-scheduler.service';
import { ReengagementAnchorService } from '@agent/reengagement/anchor.service';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { DeliveryFailureError } from '@wecom/message/types';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { AlertLevel } from '@enums/alert.enum';
import { FilterReason } from '@wecom/message/application/filter.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { LongTermService } from '@memory/services/long-term.service';
import { SessionService } from '@memory/services/session.service';
import { OpsEventsRecorderService } from '@biz/ops-events/ops-events-recorder.service';
import { HostingMemberConfigService } from '@biz/hosting-config/services/hosting-member-config.service';
import { UserHostingService } from '@biz/user/services/user-hosting.service';
import { InterventionService } from '@biz/intervention/intervention.service';
import { HandoffRecorderService } from '@biz/handoff-events/handoff-recorder.service';
import { GeneralHandoffNotifierService } from '@notification/services/general-handoff-notifier.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';

describe('MessagePipelineService', () => {
  let service: MessagePipelineService;

  const mockDeduplicationService = {
    isMessageProcessedAsync: jest.fn(),
    markMessageAsProcessedAsync: jest.fn(),
  };

  const mockChatSessionService = {
    saveMessage: jest.fn(),
    getChatSessionMessages: jest.fn(),
  };

  const mockFilterService = {
    validate: jest.fn(),
  };

  const mockDeliveryService = {
    deliverReply: jest.fn(),
  };

  const mockImageDescriptionService = {
    describeAndUpdateAsync: jest.fn(),
    awaitVision: jest.fn().mockResolvedValue(undefined),
  };

  const mockLlmService = {
    supportsVisionInput: jest.fn().mockReturnValue(true),
  };

  const mockRunnerService = {
    invoke: jest.fn(),
    invokeReviewed: jest.fn(),
    precheckInboundOutcome: jest.fn().mockResolvedValue(null),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(''),
  };

  const mockSystemConfigService = {
    getSystemConfig: jest.fn().mockResolvedValue(undefined),
    getAiReplyEnabled: jest.fn().mockResolvedValue(true),
    getMessageMergeEnabled: jest.fn().mockResolvedValue(true),
    getAgentReplyConfig: jest.fn().mockResolvedValue({}),
    onAiReplyChange: jest.fn(),
    onMessageMergeChange: jest.fn(),
  };

  const mockRuntimeConfigService = {
    resolveWecomChatModelSelection: jest.fn().mockResolvedValue({
      overrideModelId: undefined,
    }),
    getMergeDelayMs: jest.fn().mockReturnValue(2000),
  };

  const mockMonitoringService = {
    recordMessageReceived: jest.fn(),
    recordAiStart: jest.fn(),
    recordAiEnd: jest.fn(),
    recordSendStart: jest.fn(),
    recordSendEnd: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockAlertService = {
    sendAlert: jest.fn(),
  };

  const mockWecomObservabilityService = {
    hasTrace: jest.fn().mockReturnValue(false),
    startRequestTrace: jest.fn(),
    startTrace: jest.fn(),
    markHistoryStored: jest.fn(),
    markImagePrepared: jest.fn(),
    markQueueAdd: jest.fn(),
    mergePrepTimingsFromSources: jest.fn(),
    buildFailureMetadata: jest
      .fn()
      .mockImplementation((_messageId: string, payload: { errorType?: string }) => ({
        alertType: payload.errorType,
      })),
    updateDispatch: jest.fn(),
    markWorkerStart: jest.fn(),
    buildSuccessMetadata: jest
      .fn()
      .mockImplementation(
        (_messageId: string, payload: { replyPreview?: string; replySegments?: number }) => ({
          tokenUsage: 30,
          replyPreview: payload.replyPreview,
          replySegments: payload.replySegments,
        }),
      ),
    markFallbackStart: jest.fn(),
    markFallbackEnd: jest.fn(),
    markAiStart: jest.fn(),
    recordAgentRequest: jest.fn(),
    recordAgentResult: jest.fn(),
    markAiEnd: jest.fn(),
    buildMergedRequestContent: jest
      .fn()
      .mockImplementation((messages: EnterpriseMessageCallbackDto[]) =>
        messages
          .map((message) =>
            'text' in message.payload ? ((message.payload as { text?: string }).text ?? '') : '',
          )
          .filter(Boolean)
          .join('\n'),
      ),
  };

  const mockLongTermService = {
    updateMessageMetadata: jest.fn(),
  };

  const mockHostingMemberConfigService = {
    resolveFeishuReceiver: jest.fn().mockResolvedValue(undefined),
  };

  const mockUserHostingService = {
    isAnyPaused: jest.fn().mockResolvedValue({ paused: false }),
    pauseUser: jest.fn().mockResolvedValue(undefined),
  };

  const mockInterventionService = {
    dispatch: jest
      .fn()
      .mockResolvedValue({ dispatched: true, paused: true, alerted: true }),
  };

  const mockHandoffRecorder = {
    record: jest.fn().mockResolvedValue('inserted'),
  };

  const mockSimpleMergeService = {
    claimPendingSnapshot: jest
      .fn()
      .mockResolvedValue({ messages: [], snapshotSize: 0, batchId: '' }),
    ackPendingMessages: jest.fn().mockResolvedValue(undefined),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
    botUserId: 'manager-bob',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1700000000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    imContactId: 'contact-123',
    contactName: 'Alice',
    payload: { text: 'Hello!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagePipelineService,
        AcceptInboundMessageService,
        ReplyWorkflowService,
        MessageProcessingFailureService,
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessageRuntimeConfigService, useValue: mockRuntimeConfigService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: MessageFilterService, useValue: mockFilterService },
        { provide: MessageDeliveryService, useValue: mockDeliveryService },
        { provide: ImageDescriptionService, useValue: mockImageDescriptionService },
        { provide: LlmExecutorService, useValue: mockLlmService },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: AgentRunnerService, useValue: mockRunnerService },
        {
          provide: TurnOutcomeInterventionService,
          useValue: { commit: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: AlertNotifierService, useValue: mockAlertService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
        { provide: LongTermService, useValue: mockLongTermService },
        {
          provide: SessionService,
          useValue: {
            saveLastCandidateMessageAt: jest.fn().mockResolvedValue(undefined),
            saveTerminalState: jest.fn().mockResolvedValue(undefined),
            recordCandidateActivity: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: HostingMemberConfigService, useValue: mockHostingMemberConfigService },
        { provide: UserHostingService, useValue: mockUserHostingService },
        { provide: InterventionService, useValue: mockInterventionService },
        { provide: HandoffRecorderService, useValue: mockHandoffRecorder },
        {
          provide: OpsEventsRecorderService,
          useValue: {
            recordEvent: jest.fn().mockResolvedValue(true),
            recordCandidateMessage: jest
              .fn()
              .mockResolvedValue({ messageRecorded: true, engaged: false }),
          },
        },
        {
          provide: GeneralHandoffNotifierService,
          useValue: { notify: jest.fn().mockResolvedValue(true) },
        },
        {
          provide: GroupBlacklistService,
          useValue: { isGroupBlacklisted: jest.fn().mockResolvedValue(false) },
        },
        {
          provide: FollowUpSchedulerService,
          useValue: { scheduleFollowUp: jest.fn().mockResolvedValue({ scheduled: true }) },
        },
        // ReplyWorkflowService 第 14 个构造依赖；其自身依赖（FollowUpScheduler/SessionService）
        // 已在上面提供，直接注册真实类即可解析。
        ReengagementAnchorService,
      ],
    }).compile();

    service = module.get<MessagePipelineService>(MessagePipelineService);
    jest.clearAllMocks();

    mockDeduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    mockDeduplicationService.markMessageAsProcessedAsync.mockResolvedValue(true);
    mockChatSessionService.saveMessage.mockResolvedValue(true);
    mockChatSessionService.getChatSessionMessages.mockResolvedValue({
      messages: [{ role: 'user', candidateName: 'Alice' }],
    });
    mockFilterService.validate.mockResolvedValue({ pass: true, content: 'Hello!' });
    mockRunnerService.precheckInboundOutcome.mockResolvedValue(null);
    mockDeliveryService.deliverReply.mockResolvedValue({
      success: true,
      segmentCount: 1,
      deliveredSegments: 1,
      failedSegments: 0,
      totalTime: 10,
    });
    mockRunnerService.invoke.mockResolvedValue({
      text: 'Reply from agent',
      steps: 1,
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      toolCalls: [],
    });
    // ReplyWorkflowService 现走 runner.invokeReviewed；委托给 invoke 并叠加 pass 裁决，保留既有断言。
    mockRunnerService.invokeReviewed.mockImplementation(async (params: unknown) => ({
      ...(await mockRunnerService.invoke(params)),
      outputDecision: {
        decision: 'pass',
        riskLevel: 'low',
        violations: [],
        ruleIds: [],
        blockedRuleIds: [],
      },
      revised: false,
    }));
    mockAlertService.sendAlert.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('execute', () => {
    it('should store self messages as assistant history and stop dispatch', async () => {
      const result = await service.execute({ ...validMessageData, isSelf: true });

      expect(result).toEqual({
        shouldDispatch: false,
        response: { success: true, message: 'Self message stored' },
      });
      expect(mockChatSessionService.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'assistant',
          timestamp: 1700000000000,
        }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should store historyOnly messages and mark them processed', async () => {
      mockFilterService.validate.mockResolvedValue({
        pass: true,
        historyOnly: true,
        reason: FilterReason.GROUP_BLACKLISTED,
        content: 'History only message',
      });

      const result = await service.execute(validMessageData);

      expect(result).toEqual({
        shouldDispatch: false,
        response: { success: true, message: 'Message recorded to history only' },
      });
      expect(mockChatSessionService.saveMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          role: 'user',
          content: 'History only message',
          timestamp: 1700000000000,
        }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should return dispatch result without running pre-Agent intercept during execute()', async () => {
      const result = await service.execute(validMessageData);

      expect(result).toEqual({
        shouldDispatch: true,
        response: { success: true, message: 'Message received' },
        content: 'Hello!',
      });
      // Pre-Agent 风险预检由 runner.precheckInboundOutcome 在 ReplyWorkflow 内部编排，execute() 阶段不触发
      expect(mockRunnerService.precheckInboundOutcome).not.toHaveBeenCalled();
      expect(mockImageDescriptionService.describeAndUpdateAsync).not.toHaveBeenCalled();
      expect(mockRunnerService.invoke).not.toHaveBeenCalled();
    });
  });

  describe('processSingleMessage', () => {
    it('should invoke agent with tenant and user context, then mark success', async () => {
      await service.processSingleMessage(validMessageData);

      expect(mockRunnerService.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Hello!' }],
          userId: 'contact-123',
          corpId: 'org-123',
          sessionId: 'chat-123',
        }),
      );
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledWith(
        'msg-123',
        expect.objectContaining({
          tokenUsage: 30,
          replyPreview: 'Reply from agent',
        }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should still complete message processing when booking tool is used', async () => {
      mockRunnerService.invoke.mockResolvedValue({
        text: 'Reply from agent',
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { jobId: 100 },
            result: { success: true, message: '预约成功' },
          },
        ],
      });

      await service.processSingleMessage(validMessageData);

      expect(mockDeliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({
          content: 'Reply from agent',
        }),
        expect.anything(),
        true,
      );
    });

    it('should pass formatted location content to the agent', async () => {
      await service.processSingleMessage({
        ...validMessageData,
        messageType: MessageType.LOCATION,
        payload: {
          name: '东方明珠',
          address: '浦东新区世纪大道1号',
          latitude: '31.2',
          longitude: '121.4',
        },
      });

      expect(mockRunnerService.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: '[位置分享] 东方明珠（浦东新区世纪大道1号） [经纬度:31.2,121.4]',
            },
          ],
        }),
      );
    });

    it('should not send fallback or mark success when reply was only partially delivered', async () => {
      mockDeliveryService.deliverReply.mockRejectedValue(
        new DeliveryFailureError('partial delivery failure', {
          success: false,
          segmentCount: 2,
          failedSegments: 1,
          deliveredSegments: 1,
          totalTime: 20,
          error: 'partial delivery failure',
        }),
      );

      await service.processSingleMessage(validMessageData);

      expect(mockMonitoringService.recordFailure).toHaveBeenCalledWith(
        'msg-123',
        'partial delivery failure',
        expect.objectContaining({ alertType: 'delivery' }),
      );
      expect(mockDeliveryService.deliverReply).toHaveBeenCalledTimes(1);
      expect(mockMonitoringService.recordSuccess).not.toHaveBeenCalled();
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should classify agentMeta-only errors as agent alerts and include structured diagnostics', async () => {
      const error = new Error('All models failed') as Error & {
        agentMeta?: Record<string, unknown>;
        apiKey?: string;
      };
      error.agentMeta = {
        modelsAttempted: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
        lastCategory: 'rate_limited',
        totalAttempts: 2,
        messageCount: 8,
        sessionId: 'chat-123',
        memoryLoadWarning: 'shortTerm: Connection timeout',
      };
      error.apiKey = 'sk-test-1234567890abcdef';
      mockRunnerService.invoke.mockRejectedValue(error);

      await service.processSingleMessage(validMessageData);

      expect(mockAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'agent.invoke_failed',
          severity: AlertLevel.WARNING,
          scope: expect.objectContaining({
            chatId: 'chat-123',
            sessionId: 'chat-123',
            messageId: 'msg-123',
            contactName: 'Alice',
            scenario: 'candidate-consultation',
          }),
          impact: expect.objectContaining({
            userMessage: 'Hello!',
            requiresHumanIntervention: true,
          }),
          diagnostics: expect.objectContaining({
            modelChain: ['anthropic/claude-sonnet-4', 'openai/gpt-4o'],
            category: 'rate_limited',
            totalAttempts: 2,
            messageCount: 8,
            memoryWarning: 'shortTerm: Connection timeout',
            dispatchMode: 'direct',
            payload: expect.objectContaining({
              apiKey: expect.stringContaining('sk-tes'),
            }),
          }),
        }),
        // 消息失败路径由 recordFailure 落库，告警不重复持久化
        { persist: false },
      );
    });

    it('should process merged messages and mark all source messages as processed', async () => {
      await service.processMergedMessages(
        [
          validMessageData,
          {
            ...validMessageData,
            messageId: 'msg-456',
            payload: { text: 'Second message' },
          },
        ],
        'batch-001',
        2,
      );

      expect(mockRunnerService.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: 'Hello!\nSecond message' }],
          sessionId: 'chat-123',
        }),
      );
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledWith(
        'batch-001',
        expect.objectContaining({
          replyPreview: 'Reply from agent',
        }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-456');
    });
  });
});
