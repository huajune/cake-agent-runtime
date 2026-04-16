import { Test, TestingModule } from '@nestjs/testing';
import { MessageService } from '@wecom/message/message.service';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { MessageDeduplicationService } from '@wecom/message/runtime/deduplication.service';
import { MessagePipelineService } from '@wecom/message/application/pipeline.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { MessageRuntimeConfigService } from '@wecom/message/runtime/message-runtime-config.service';

describe('MessageService', () => {
  let service: MessageService;

  const mockSimpleMergeService = {
    addMessage: jest.fn(),
  };

  const mockDeduplicationService = {
    clearAll: jest.fn(),
    markMessageAsProcessedAsync: jest.fn(),
  };

  const mockPipelineService = {
    execute: jest.fn(),
    processSingleMessage: jest.fn(),
    processMergedMessages: jest.fn(),
  };

  const mockMonitoringService = {
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockWecomObservabilityService = {
    hasTrace: jest.fn().mockReturnValue(false),
    startTrace: jest.fn(),
    startRequestTrace: jest.fn(),
    updateDispatch: jest.fn(),
    buildSuccessMetadata: jest.fn(),
    buildFailureMetadata: jest.fn(),
  };

  const mockRuntimeConfigService = {
    isAiReplyEnabled: jest.fn(),
    isMessageMergeEnabled: jest.fn(),
    syncSnapshot: jest.fn().mockResolvedValue(undefined),
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
        MessageService,
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessagePipelineService, useValue: mockPipelineService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: MessageRuntimeConfigService, useValue: mockRuntimeConfigService },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    jest.clearAllMocks();

    mockRuntimeConfigService.isAiReplyEnabled.mockReturnValue(true);
    mockRuntimeConfigService.isMessageMergeEnabled.mockReturnValue(true);
    mockWecomObservabilityService.buildSuccessMetadata.mockReturnValue({
      replyPreview: '[AI回复已禁用]',
      replySegments: 0,
      extraResponse: { disabledAiReply: true },
    });
    mockWecomObservabilityService.buildFailureMetadata.mockReturnValue({
      alertType: 'merge',
    });
    mockPipelineService.execute.mockResolvedValue({
      shouldDispatch: true,
      response: { success: true, message: 'Message received' },
    });
    mockPipelineService.processSingleMessage.mockResolvedValue(undefined);
    mockPipelineService.processMergedMessages.mockResolvedValue(undefined);
    mockSimpleMergeService.addMessage.mockResolvedValue(undefined);
    mockDeduplicationService.markMessageAsProcessedAsync.mockResolvedValue(true);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should read current toggle states from runtime config', async () => {
      await service.onModuleInit();

      expect(mockRuntimeConfigService.isAiReplyEnabled).toHaveBeenCalled();
      expect(mockRuntimeConfigService.isMessageMergeEnabled).toHaveBeenCalled();
    });
  });

  describe('handleMessage', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should return pipeline response when dispatch is not needed', async () => {
      mockPipelineService.execute.mockResolvedValue({
        shouldDispatch: false,
        response: { success: true, message: 'Duplicate message ignored' },
      });

      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Duplicate message ignored' });
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });

    it('should mark message processed when AI reply is disabled', async () => {
      mockRuntimeConfigService.isAiReplyEnabled.mockReturnValue(false);

      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({
        success: true,
        message: 'AI reply disabled, message recorded to history',
      });
      expect(mockWecomObservabilityService.startRequestTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-123',
        }),
      );
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledWith(
        'msg-123',
        expect.objectContaining({ replyPreview: '[AI回复已禁用]' }),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should enqueue messages when merge is enabled', async () => {
      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockSimpleMergeService.addMessage).toHaveBeenCalledWith(validMessageData);
      expect(mockPipelineService.processSingleMessage).not.toHaveBeenCalled();
    });

    it('should record failure when merge enqueue fails', async () => {
      mockSimpleMergeService.addMessage.mockRejectedValue(new Error('redis down'));

      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockWecomObservabilityService.startRequestTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          traceId: 'msg-123',
        }),
      );
      expect(mockWecomObservabilityService.updateDispatch).toHaveBeenCalledWith('msg-123', 'merged');
      expect(mockWecomObservabilityService.buildFailureMetadata).toHaveBeenCalledWith(
        'msg-123',
        expect.objectContaining({
          errorType: 'merge',
          errorMessage: 'redis down',
        }),
      );
      expect(mockMonitoringService.recordFailure).toHaveBeenCalledWith(
        'msg-123',
        'redis down',
        expect.anything(),
      );
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
    });

    it('should process message immediately when merge is disabled', async () => {
      mockRuntimeConfigService.isMessageMergeEnabled.mockReturnValue(false);

      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({ success: true, message: 'Message received' });
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockPipelineService.processSingleMessage).toHaveBeenCalledWith(validMessageData);
      expect(mockSimpleMergeService.addMessage).not.toHaveBeenCalled();
    });
  });

  describe('processMergedMessages', () => {
    it('should delegate to pipeline service', async () => {
      await service.processMergedMessages([validMessageData], 'batch-001');

      expect(mockPipelineService.processMergedMessages).toHaveBeenCalledWith(
        [validMessageData],
        'batch-001',
      );
    });
  });
});
