import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageService } from '@wecom/message/message.service';
import { SimpleMergeService } from '@wecom/message/services/simple-merge.service';
import { MessageDeduplicationService } from '@wecom/message/services/deduplication.service';
import { MessagePipelineService } from '@wecom/message/services/pipeline.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { WecomMessageObservabilityService } from '@wecom/message/services/wecom-message-observability.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';

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
    updateDispatch: jest.fn(),
    buildSuccessMetadata: jest.fn(),
    buildFailureMetadata: jest.fn(),
  };

  const mockSystemConfigService = {
    getAiReplyEnabled: jest.fn(),
    getMessageMergeEnabled: jest.fn(),
    onAiReplyChange: jest.fn(),
    onMessageMergeChange: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'ENABLE_AI_REPLY') return 'true';
      if (key === 'ENABLE_MESSAGE_MERGE') return 'true';
      return defaultValue;
    }),
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
        { provide: ConfigService, useValue: mockConfigService },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessagePipelineService, useValue: mockPipelineService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    jest.clearAllMocks();

    mockSystemConfigService.getAiReplyEnabled.mockResolvedValue(true);
    mockSystemConfigService.getMessageMergeEnabled.mockResolvedValue(true);
    mockSystemConfigService.onAiReplyChange.mockImplementation(() => {});
    mockSystemConfigService.onMessageMergeChange.mockImplementation(() => {});
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
    it('should load toggle states from SystemConfigService', async () => {
      await service.onModuleInit();

      expect(mockSystemConfigService.getAiReplyEnabled).toHaveBeenCalled();
      expect(mockSystemConfigService.getMessageMergeEnabled).toHaveBeenCalled();
      expect(mockSystemConfigService.onAiReplyChange).toHaveBeenCalled();
      expect(mockSystemConfigService.onMessageMergeChange).toHaveBeenCalled();
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
      mockSystemConfigService.getAiReplyEnabled.mockResolvedValue(false);
      await service.onModuleInit();

      const result = await service.handleMessage(validMessageData);

      expect(result).toEqual({
        success: true,
        message: 'AI reply disabled, message recorded to history',
      });
      expect(mockWecomObservabilityService.startTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-123',
          chatId: 'chat-123',
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
      expect(mockWecomObservabilityService.startTrace).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'msg-123',
          chatId: 'chat-123',
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
      mockSystemConfigService.getMessageMergeEnabled.mockResolvedValue(false);
      await service.onModuleInit();

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
