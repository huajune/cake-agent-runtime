import { Test, TestingModule } from '@nestjs/testing';
import { MessagePipelineService } from '@wecom/message/services/pipeline.service';
import { MessageDeduplicationService } from '@wecom/message/services/deduplication.service';
import { MessageHistoryService } from '@wecom/message/services/history.service';
import { MessageFilterService } from '@wecom/message/services/filter.service';
import { MessageDeliveryService } from '@wecom/message/services/delivery.service';
import { AgentGatewayService } from '@wecom/message/services/agent-gateway.service';
import { BookingDetectionService } from '@wecom/message/services/booking-detection.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import {
  EnterpriseMessageCallbackDto,
  MessageType,
  ContactType,
  MessageSource,
} from '@wecom/message/dto/message-callback.dto';
import { FilterReason } from '@wecom/message/services/filter.service';

describe('MessagePipelineService', () => {
  let service: MessagePipelineService;

  const mockDeduplicationService = {
    isMessageProcessedAsync: jest.fn(),
    markMessageAsProcessedAsync: jest.fn(),
  };

  const mockHistoryService = {
    addMessageToHistory: jest.fn(),
    getHistoryForContext: jest.fn(),
    getHistoryDetail: jest.fn(),
  };

  const mockFilterService = {
    validate: jest.fn(),
  };

  const mockDeliveryService = {
    deliverReply: jest.fn(),
  };

  const mockAgentGateway = {
    invoke: jest.fn(),
    getFallbackMessage: jest.fn(),
  };

  const mockBookingDetection = {
    handleBookingSuccessAsync: jest.fn(),
  };

  const mockMonitoringService = {
    recordMessageReceived: jest.fn(),
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn(),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
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
    botUserId: 'manager-bob',
    payload: { text: 'Hello!' },
  };

  const successAgentResult = {
    reply: {
      content: 'Hi there! How can I help?',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    },
    isFallback: false,
    processingTime: 500,
  };

  const successDeliveryResult = {
    success: true,
    segmentCount: 1,
    failedSegments: 0,
    totalTime: 100,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessagePipelineService,
        { provide: MessageDeduplicationService, useValue: mockDeduplicationService },
        { provide: MessageHistoryService, useValue: mockHistoryService },
        { provide: MessageFilterService, useValue: mockFilterService },
        { provide: MessageDeliveryService, useValue: mockDeliveryService },
        { provide: AgentGatewayService, useValue: mockAgentGateway },
        { provide: BookingDetectionService, useValue: mockBookingDetection },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
      ],
    }).compile();

    service = module.get<MessagePipelineService>(MessagePipelineService);
    jest.clearAllMocks();

    mockHistoryService.addMessageToHistory.mockResolvedValue(undefined);
    mockHistoryService.getHistoryForContext.mockResolvedValue([]);
    mockHistoryService.getHistoryDetail.mockResolvedValue(null);
    mockDeduplicationService.isMessageProcessedAsync.mockResolvedValue(false);
    mockDeduplicationService.markMessageAsProcessedAsync.mockResolvedValue(true);
    mockAgentGateway.invoke.mockResolvedValue(successAgentResult);
    mockAgentGateway.getFallbackMessage.mockReturnValue('抱歉，我暂时无法回复');
    mockDeliveryService.deliverReply.mockResolvedValue(successDeliveryResult);
    mockBookingDetection.handleBookingSuccessAsync.mockResolvedValue(undefined);
    mockMonitoringService.recordMessageReceived.mockReturnValue(undefined);
    mockMonitoringService.recordSuccess.mockReturnValue(undefined);
    mockMonitoringService.recordFailure.mockReturnValue(undefined);
    mockFeishuAlertService.sendAlert.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('handleSelfMessage', () => {
    it('should store isSelf message as assistant history', async () => {
      const selfMessage = { ...validMessageData, isSelf: true };
      mockHistoryService.getHistoryDetail.mockResolvedValue(null);

      await service.handleSelfMessage(selfMessage);

      expect(mockHistoryService.addMessageToHistory).toHaveBeenCalledWith(
        'chat-123',
        'assistant',
        'Hello!',
        expect.objectContaining({
          messageId: 'msg-123',
          isSelf: true,
        }),
      );
    });

    it('should skip storing when content is empty', async () => {
      const emptyMessage = { ...validMessageData, isSelf: true, payload: { text: '   ' } };

      await service.handleSelfMessage(emptyMessage);

      expect(mockHistoryService.addMessageToHistory).not.toHaveBeenCalled();
    });

    it('should use candidateName from history when available', async () => {
      const mockDetail = {
        chatId: 'chat-123',
        messages: [{ role: 'user', candidateName: 'HistoryAlice', content: 'hi', timestamp: 1 }],
        messageCount: 1,
      };
      mockHistoryService.getHistoryDetail.mockResolvedValue(mockDetail);

      await service.handleSelfMessage({ ...validMessageData, isSelf: true });

      expect(mockHistoryService.addMessageToHistory).toHaveBeenCalledWith(
        expect.any(String),
        'assistant',
        expect.any(String),
        expect.objectContaining({ candidateName: 'HistoryAlice' }),
      );
    });
  });

  describe('filterMessage', () => {
    it('should return continue=true for valid message', async () => {
      mockFilterService.validate.mockResolvedValue({ pass: true, content: 'Hello!' });

      const result = await service.filterMessage(validMessageData);

      expect(result.continue).toBe(true);
      expect(result.data!.content).toBe('Hello!');
    });

    it('should return continue=false for filtered message', async () => {
      mockFilterService.validate.mockResolvedValue({
        pass: false,
        reason: FilterReason.SELF_MESSAGE,
      });

      const result = await service.filterMessage(validMessageData);

      expect(result.continue).toBe(false);
      expect(result.response).toBeDefined();
    });

    it('should record history and return continue=false for historyOnly message', async () => {
      mockFilterService.validate.mockResolvedValue({
        pass: true,
        historyOnly: true,
        reason: FilterReason.GROUP_BLACKLISTED,
        content: 'Hello!',
      });

      const result = await service.filterMessage(validMessageData);

      expect(result.continue).toBe(false);
      expect(mockHistoryService.addMessageToHistory).toHaveBeenCalledWith(
        'chat-123',
        'user',
        'Hello!',
        expect.any(Object),
      );
    });
  });

  describe('checkDuplicationAsync', () => {
    it('should return continue=true for new message', async () => {
      mockDeduplicationService.isMessageProcessedAsync.mockResolvedValue(false);

      const result = await service.checkDuplicationAsync(validMessageData);

      expect(result.continue).toBe(true);
    });

    it('should return continue=false for duplicate message', async () => {
      mockDeduplicationService.isMessageProcessedAsync.mockResolvedValue(true);

      const result = await service.checkDuplicationAsync(validMessageData);

      expect(result.continue).toBe(false);
      expect(result.response).toMatchObject({
        success: true,
        message: 'Duplicate message ignored',
      });
    });
  });

  describe('recordUserMessageToHistory', () => {
    it('should save user message to history with metadata', async () => {
      await service.recordUserMessageToHistory(validMessageData);

      expect(mockHistoryService.addMessageToHistory).toHaveBeenCalledWith(
        'chat-123',
        'user',
        'Hello!',
        expect.objectContaining({
          messageId: 'msg-123',
          candidateName: 'Alice',
          managerName: 'manager-bob',
        }),
      );
    });

    it('should use contentFromFilter when provided', async () => {
      await service.recordUserMessageToHistory(validMessageData, 'Overridden content');

      expect(mockHistoryService.addMessageToHistory).toHaveBeenCalledWith(
        expect.any(String),
        'user',
        'Overridden content',
        expect.any(Object),
      );
    });

    it('should skip storing when content is empty', async () => {
      const emptyMessage = { ...validMessageData, payload: {} };

      await service.recordUserMessageToHistory(emptyMessage, '   ');

      expect(mockHistoryService.addMessageToHistory).not.toHaveBeenCalled();
    });
  });

  describe('recordMessageReceived', () => {
    it('should call monitoring service with parsed message data', () => {
      service.recordMessageReceived(validMessageData);

      expect(mockMonitoringService.recordMessageReceived).toHaveBeenCalledWith(
        'msg-123',
        'chat-123',
        'contact-123',
        'Alice',
        'Hello!',
        expect.any(Object),
        'manager-bob',
      );
    });
  });

  describe('processSingleMessage', () => {
    it('should process single message through full pipeline', async () => {
      await service.processSingleMessage(validMessageData);

      expect(mockHistoryService.getHistoryForContext).toHaveBeenCalledWith('chat-123', 'msg-123');
      expect(mockAgentGateway.invoke).toHaveBeenCalled();
      expect(mockDeliveryService.deliverReply).toHaveBeenCalled();
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledWith(
        'msg-123',
        expect.any(Object),
      );
    });

    it('should invoke booking detection asynchronously', async () => {
      await service.processSingleMessage(validMessageData);

      expect(mockBookingDetection.handleBookingSuccessAsync).toHaveBeenCalled();
    });

    it('should handle processing error and send fallback reply', async () => {
      mockAgentGateway.invoke.mockRejectedValue(new Error('Agent API failed'));

      // Should not throw - error is handled internally
      await service.processSingleMessage(validMessageData);

      expect(mockMonitoringService.recordFailure).toHaveBeenCalledWith(
        'msg-123',
        'Agent API failed',
        expect.any(Object),
      );
      expect(mockDeliveryService.deliverReply).toHaveBeenCalledWith(
        expect.objectContaining({ content: '抱歉，我暂时无法回复' }),
        expect.any(Object),
        false,
      );
    });

    it('should send fallback alert when agent returns fallback response', async () => {
      const fallbackAgentResult = {
        ...successAgentResult,
        isFallback: true,
      };
      mockAgentGateway.invoke.mockResolvedValue(fallbackAgentResult);

      await service.processSingleMessage(validMessageData);

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalled();
    });
  });

  describe('processMergedMessages', () => {
    const messages = [
      validMessageData,
      { ...validMessageData, messageId: 'msg-456', payload: { text: 'Second message' } },
    ];

    it('should process merged messages using last message as primary', async () => {
      await service.processMergedMessages(messages, 'batch-001');

      expect(mockAgentGateway.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-456' }),
      );
    });

    it('should mark all messages in batch as processed on success', async () => {
      await service.processMergedMessages(messages, 'batch-001');

      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledTimes(2);
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-123');
      expect(mockDeduplicationService.markMessageAsProcessedAsync).toHaveBeenCalledWith('msg-456');
    });

    it('should record success for all messages in batch', async () => {
      await service.processMergedMessages(messages, 'batch-001');

      expect(mockMonitoringService.recordSuccess).toHaveBeenCalledTimes(2);
    });

    it('should return early when messages array is empty', async () => {
      await service.processMergedMessages([], 'batch-empty');

      expect(mockAgentGateway.invoke).not.toHaveBeenCalled();
    });

    it('should handle error and mark all non-primary messages as failed', async () => {
      mockAgentGateway.invoke.mockRejectedValue(new Error('Batch processing failed'));

      await expect(service.processMergedMessages(messages, 'batch-err')).rejects.toThrow(
        'Batch processing failed',
      );

      expect(mockMonitoringService.recordFailure).toHaveBeenCalled();
    });
  });
});
