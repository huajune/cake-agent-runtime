import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessagePipelineService } from '@wecom/message/services/pipeline.service';
import { MessageDeduplicationService } from '@wecom/message/services/deduplication.service';
import { MessageFilterService } from '@wecom/message/services/filter.service';
import { MessageDeliveryService } from '@wecom/message/services/delivery.service';
import { ImageDescriptionService } from '@wecom/message/services/image-description.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { AlertNotifierService } from '@notification/services/alert-notifier.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { AgentRunnerService } from '@agent/runner.service';
import { WecomMessageObservabilityService } from '@wecom/message/services/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/message-callback.dto';
import { DeliveryFailureError } from '@wecom/message/message.types';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { AlertLevel } from '@enums/alert.enum';
import { FilterReason } from '@wecom/message/services/filter.service';

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
  };

  const mockRunnerService = {
    invoke: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockReturnValue(''),
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
    startTrace: jest.fn(),
    markHistoryStored: jest.fn(),
    markImagePrepared: jest.fn(),
    buildFailureMetadata: jest.fn().mockImplementation(
      (_messageId: string, payload: { errorType?: string }) => ({
        alertType: payload.errorType,
      }),
    ),
    updateDispatch: jest.fn(),
    markWorkerStart: jest.fn(),
    buildSuccessMetadata: jest.fn().mockImplementation(
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
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: MessageFilterService, useValue: mockFilterService },
        { provide: MessageDeliveryService, useValue: mockDeliveryService },
        { provide: ImageDescriptionService, useValue: mockImageDescriptionService },
        { provide: AgentRunnerService, useValue: mockRunnerService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: AlertNotifierService, useValue: mockAlertService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
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
  });

  describe('processSingleMessage', () => {
    it('should invoke agent with tenant and user context, then mark success', async () => {
      await service.processSingleMessage(validMessageData);

      expect(mockRunnerService.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          userMessage: 'Hello!',
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
          userMessage: '[位置分享] 东方明珠（浦东新区世纪大道1号） [经纬度:31.2,121.4]',
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
      expect(mockDeduplicationService.markMessageAsProcessedAsync).not.toHaveBeenCalled();
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
      );
    });
  });
});
