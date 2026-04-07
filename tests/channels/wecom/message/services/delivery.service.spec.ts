import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageDeliveryService } from '@wecom/message/services/delivery.service';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import {
  DeliveryContext,
  DeliveryFailureError,
  AgentReply,
} from '@wecom/message/message.types';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { WecomMessageObservabilityService } from '@wecom/message/services/wecom-message-observability.service';

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
  };

  const mockMonitoringService = {
    recordSendStart: jest.fn(),
    recordSendEnd: jest.fn(),
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

  const mockSystemConfigService = {
    onAgentReplyConfigChange: jest.fn(),
    getAgentReplyConfig: jest.fn(),
  };

  const mockWecomObservabilityService = {
    markDeliveryStart: jest.fn(),
    markDeliveryEnd: jest.fn(),
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
        { provide: ConfigService, useValue: mockConfigService },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
      ],
    }).compile();

    service = module.get<MessageDeliveryService>(MessageDeliveryService);
    jest.clearAllMocks();

    mockMessageSenderService.sendMessage.mockResolvedValue({ success: true });
    mockMonitoringService.recordSendStart.mockReturnValue(undefined);
    mockMonitoringService.recordSendEnd.mockReturnValue(undefined);
    mockFeishuAlertService.sendAlert.mockResolvedValue(undefined);
    mockSystemConfigService.onAgentReplyConfigChange.mockImplementation(() => {});
    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue({
      typingSpeedCharsPerSec: 8,
    });

    jest.spyOn(service as any, 'sleep').mockImplementation(async () => undefined);
    jest.spyOn(service as any, 'calculateDelay').mockImplementation(() => 0);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('deliverReply', () => {
    it('should send single message for short content', async () => {
      const reply: AgentReply = { content: 'Short message' };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.success).toBe(true);
      expect(result.segmentCount).toBe(1);
      expect(result.deliveredSegments).toBe(1);
      expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(1);
      expect(mockMonitoringService.recordSendStart).toHaveBeenCalledWith('msg-123');
      expect(mockMonitoringService.recordSendEnd).toHaveBeenCalledWith('msg-123');
    });

    it('should split and send multiple messages when content contains double newlines', async () => {
      const reply: AgentReply = {
        content: 'First paragraph\n\nSecond paragraph\n\nThird paragraph',
      };

      const result = await service.deliverReply(reply, deliveryContext, true);

      expect(result.success).toBe(true);
      expect(result.segmentCount).toBe(3);
      expect(result.deliveredSegments).toBe(3);
      expect(mockMessageSenderService.sendMessage).toHaveBeenCalledTimes(3);
    });

    it('should skip monitoring when recordMonitoring=false', async () => {
      await service.deliverReply({ content: 'Hello' }, deliveryContext, false);

      expect(mockMonitoringService.recordSendStart).not.toHaveBeenCalled();
      expect(mockMonitoringService.recordSendEnd).not.toHaveBeenCalled();
    });

    it('should throw DeliveryFailureError when single send fails', async () => {
      mockMessageSenderService.sendMessage.mockRejectedValue(new Error('Send failed'));

      await expect(service.deliverReply({ content: 'Hello' }, deliveryContext, true)).rejects.toBeInstanceOf(
        DeliveryFailureError,
      );

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'delivery' }),
      );
    });

    it('should expose delivered segment count for partial failures', async () => {
      mockMessageSenderService.sendMessage
        .mockResolvedValueOnce({ success: true })
        .mockRejectedValueOnce(new Error('Segment 2 failed'))
        .mockResolvedValueOnce({ success: true });

      let error: DeliveryFailureError | null = null;
      try {
        await service.deliverReply(
          { content: 'First part\n\nSecond part\n\nThird part' },
          deliveryContext,
          true,
        );
      } catch (caught) {
        error = caught as DeliveryFailureError;
      }

      expect(error).toBeInstanceOf(DeliveryFailureError);
      expect(error?.result.segmentCount).toBe(3);
      expect(error?.result.failedSegments).toBe(1);
      expect(error?.result.deliveredSegments).toBe(2);
      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({ errorType: 'delivery' }),
      );
    });
  });
});
