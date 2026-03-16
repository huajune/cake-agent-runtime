import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageDeliveryService } from '@wecom/message/services/message-delivery.service';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { TypingDelayService } from '@wecom/message/services/message-typing-delay.service';
import { FeishuAlertService } from '@core/feishu';
import { DeliveryContext } from '@wecom/message/types';

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
  };

  const mockMonitoringService = {
    recordSendStart: jest.fn(),
    recordSendEnd: jest.fn(),
  };

  const mockTypingDelayService = {
    calculateDelay: jest.fn(),
    delay: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'ENABLE_MESSAGE_SPLIT_SEND') return 'true';
      return defaultValue;
    }),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn(),
  };

  const deliveryContext: DeliveryContext = {
    token: 'token-123',
    imBotId: 'wxid-bot-123',
    imContactId: 'wxid-contact-123',
    imRoomId: '',
    contactName: 'Alice',
    messageId: 'msg-123',
    chatId: 'chat-123',
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageDeliveryService,
        { provide: MessageSenderService, useValue: mockMessageSenderService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: TypingDelayService, useValue: mockTypingDelayService },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
      ],
    }).compile();

    service = module.get<MessageDeliveryService>(MessageDeliveryService);
    jest.clearAllMocks();

    mockMessageSenderService.sendMessage.mockResolvedValue({ success: true });
    mockMonitoringService.recordSendStart.mockReturnValue(undefined);
    mockMonitoringService.recordSendEnd.mockReturnValue(undefined);
    mockTypingDelayService.calculateDelay.mockReturnValue(100);
    mockTypingDelayService.delay.mockResolvedValue(undefined);
    mockFeishuAlertService.sendAlert.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('deliverReply', () => {
    it('should send single message for short content', async () => {
      const reply = { content: 'Short message', rawResponse: undefined };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.success).toBe(true);
      expect(result.segmentCount).toBe(1);
      expect(result.failedSegments).toBe(0);
      expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockMonitoringService.recordSendStart).toHaveBeenCalledWith('msg-123');
      expect(mockMonitoringService.recordSendEnd).toHaveBeenCalledWith('msg-123');
    });

    it('should split and send multiple messages for long content with double newlines', async () => {
      const reply = {
        content: 'First paragraph\n\nSecond paragraph\n\nThird paragraph',
        rawResponse: undefined,
      };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.segmentCount).toBe(3);
      expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should split on fullwidth tilde separator followed by Chinese characters', async () => {
      const reply = {
        content: '好的哈～我看一下',
        rawResponse: undefined,
      };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.segmentCount).toBe(2);
    });

    it('should skip monitoring when recordMonitoring=false', async () => {
      const reply = { content: 'Hello', rawResponse: undefined };

      await service.deliverReply(reply, deliveryContext, false);

      expect(mockMonitoringService.recordSendStart).not.toHaveBeenCalled();
      expect(mockMonitoringService.recordSendEnd).not.toHaveBeenCalled();
    });

    it('should return failure result when sendMessage throws', async () => {
      mockMessageSenderService.sendMessage.mockRejectedValue(new Error('Send failed'));
      const reply = { content: 'Hello', rawResponse: undefined };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.success).toBe(false);
      expect(result.segmentCount).toBe(0);
      expect(result.failedSegments).toBe(1);
      expect(result.error).toBeDefined();
    });

    it('should send failure alert when single message send fails', async () => {
      mockMessageSenderService.sendMessage.mockRejectedValue(new Error('Network error'));
      const reply = { content: 'Hello', rawResponse: undefined };

      await service.deliverReply(reply, deliveryContext, true);

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'delivery',
        }),
      );
    });

    it('should include totalTime in result', async () => {
      const reply = { content: 'Hello', rawResponse: undefined };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(typeof result.totalTime).toBe('number');
      expect(result.totalTime).toBeGreaterThanOrEqual(0);
    });

    it('should apply typing delay between segments', async () => {
      const reply = {
        content: 'First part\n\nSecond part\n\nThird part',
        rawResponse: undefined,
      };
      mockTypingDelayService.calculateDelay.mockReturnValue(500);

      await service.deliverReply(reply, deliveryContext, true);

      expect(mockTypingDelayService.calculateDelay).toHaveBeenCalledTimes(3);
      expect(mockTypingDelayService.delay).toHaveBeenCalledTimes(3);
    });

    it('should continue sending remaining segments even if one fails', async () => {
      const reply = {
        content: 'First part\n\nSecond part\n\nThird part',
        rawResponse: undefined,
      };
      mockMessageSenderService.sendMessage
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('Segment 2 failed'))
        .mockResolvedValueOnce({ success: true });

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.segmentCount).toBe(3);
      expect(result.failedSegments).toBe(1);
      expect(result.success).toBe(false);
    });

    it('should send failure alert when any segment fails', async () => {
      const reply = {
        content: 'Part one\n\nPart two',
        rawResponse: undefined,
      };
      mockMessageSenderService.sendMessage
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('Segment failed'));

      await service.deliverReply(reply, deliveryContext, false);

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'delivery' }),
      );
    });
  });
});
