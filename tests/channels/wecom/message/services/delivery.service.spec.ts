import { Test, TestingModule } from '@nestjs/testing';
import { MessageDeliveryService } from '@wecom/message/delivery/delivery.service';
import { MessageSenderService } from '@wecom/message-sender/message-sender.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import {
  DeliveryContext,
  DeliveryFailureError,
  AgentReply,
} from '@wecom/message/types';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';
import { TypingPolicyService } from '@wecom/message/delivery/typing-policy.service';

describe('MessageDeliveryService', () => {
  let service: MessageDeliveryService;

  const mockMessageSenderService = {
    sendMessage: jest.fn(),
  };

  const mockMonitoringService = {
    recordSendStart: jest.fn(),
    recordSendEnd: jest.fn(),
  };

  const mockTypingPolicyService = {
    shouldSplit: jest.fn(),
    getSnapshot: jest.fn(),
    calculateDelay: jest.fn(),
  };

  const mockWecomObservabilityService = {
    markDeliveryStart: jest.fn(),
    markFirstSegmentSent: jest.fn(),
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
        { provide: TypingPolicyService, useValue: mockTypingPolicyService },
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservabilityService },
      ],
    }).compile();

    service = module.get<MessageDeliveryService>(MessageDeliveryService);
    jest.clearAllMocks();

    mockMessageSenderService.sendMessage.mockResolvedValue({ success: true });
    mockMonitoringService.recordSendStart.mockReturnValue(undefined);
    mockMonitoringService.recordSendEnd.mockReturnValue(undefined);
    mockTypingPolicyService.shouldSplit.mockImplementation((content: string) =>
      content.includes('\n\n'),
    );
    mockTypingPolicyService.getSnapshot.mockReturnValue({
      splitSend: true,
      typingSpeedCharsPerSec: 8,
      paragraphGapMs: 2000,
    });
    mockTypingPolicyService.calculateDelay.mockReturnValue(0);

    jest.spyOn(service as any, 'sleep').mockImplementation(async () => undefined);
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
      expect(mockWecomObservabilityService.markFirstSegmentSent).toHaveBeenCalledWith('msg-123');
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
      expect(mockWecomObservabilityService.markFirstSegmentSent).toHaveBeenCalledTimes(1);
    });

    it('should skip monitoring when recordMonitoring=false', async () => {
      await service.deliverReply({ content: 'Hello' }, deliveryContext, false);

      expect(mockMonitoringService.recordSendStart).not.toHaveBeenCalled();
      expect(mockMonitoringService.recordSendEnd).not.toHaveBeenCalled();
      expect(mockWecomObservabilityService.markFirstSegmentSent).toHaveBeenCalledWith('msg-123');
    });

    it('should throw DeliveryFailureError when single send fails', async () => {
      mockMessageSenderService.sendMessage.mockRejectedValue(new Error('Send failed'));

      await expect(service.deliverReply({ content: 'Hello' }, deliveryContext, true)).rejects.toBeInstanceOf(
        DeliveryFailureError,
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
    });
  });

  describe('calculateDelay', () => {
    it('should keep first segment delay at 0 even when paragraphGapMs is configured', async () => {
      mockTypingPolicyService.getSnapshot.mockReturnValue({
        splitSend: true,
        typingSpeedCharsPerSec: 8,
        paragraphGapMs: 2500,
      });
      mockTypingPolicyService.calculateDelay.mockImplementation((_: string, isFirstSegment = false) =>
        isFirstSegment ? 0 : 2500,
      );

      await service.onModuleInit();

      expect((service as any).calculateDelay('第一段消息', true)).toBe(0);
    });

    it('should respect paragraphGapMs as the minimum delay for non-first segments', async () => {
      mockTypingPolicyService.getSnapshot.mockReturnValue({
        splitSend: true,
        typingSpeedCharsPerSec: 8,
        paragraphGapMs: 2500,
      });
      mockTypingPolicyService.calculateDelay.mockReturnValue(2500);

      await service.onModuleInit();

      expect((service as any).calculateDelay('短句', false)).toBe(2500);
    });
  });
});
