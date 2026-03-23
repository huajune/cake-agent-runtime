import { Test, TestingModule } from '@nestjs/testing';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';
import { InterviewBookingInfo } from '@infra/feishu/interfaces/interface';

describe('FeishuBookingService', () => {
  let service: FeishuBookingService;
  let mockWebhookService: jest.Mocked<FeishuWebhookService>;

  beforeEach(async () => {
    mockWebhookService = {
      buildCard: jest.fn(),
      sendMessage: jest.fn(),
    } as unknown as jest.Mocked<FeishuWebhookService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuBookingService,
        { provide: FeishuWebhookService, useValue: mockWebhookService },
      ],
    }).compile();

    service = module.get<FeishuBookingService>(FeishuBookingService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  const buildBookingInfo = (
    overrides: Partial<InterviewBookingInfo> = {},
  ): InterviewBookingInfo => ({
    candidateName: '张三',
    brandName: '肯德基',
    storeName: '浦东南路店',
    interviewTime: '2026-03-15 14:00',
    contactInfo: '138****1234',
    chatId: 'chat_001',
    ...overrides,
  });

  describe('sendBookingNotification', () => {
    it('should send notification and return true on success', async () => {
      const mockCard = { msg_type: 'interactive', card: {} };
      mockWebhookService.buildCard.mockReturnValue(mockCard);
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const bookingInfo = buildBookingInfo();
      const result = await service.sendBookingNotification(bookingInfo);

      expect(result).toBe(true);
      expect(mockWebhookService.buildCard).toHaveBeenCalledWith(
        '🎉 面试预约成功',
        expect.stringContaining('张三'),
        'green',
        expect.any(Array),
      );
      expect(mockWebhookService.sendMessage).toHaveBeenCalledWith('INTERVIEW_BOOKING', mockCard);
    });

    it('should return false when sendMessage returns false', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(false);

      const result = await service.sendBookingNotification(buildBookingInfo());
      expect(result).toBe(false);
    });

    it('should return false when sendMessage throws an error', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockRejectedValue(new Error('Network error'));

      const result = await service.sendBookingNotification(buildBookingInfo());
      expect(result).toBe(false);
    });

    it('should include candidateName in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ candidateName: '李四' }));

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('李四');
    });

    it('should include brandName in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ brandName: '必胜客' }));

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('必胜客');
    });

    it('should include storeName in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ storeName: '南京西路店' }));

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('南京西路店');
    });

    it('should include interviewTime in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(
        buildBookingInfo({ interviewTime: '2026-03-20 10:00' }),
      );

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('2026-03-20 10:00');
    });

    it('should include contactInfo in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ contactInfo: '156****5678' }));

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('156****5678');
    });

    it('should include chatId in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ chatId: 'chat_xyz' }));

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('chat_xyz');
    });

    it('should include toolOutput info when provided', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const bookingInfo = buildBookingInfo({
        toolOutput: {
          message: '预约成功！面试时间已确认',
          booking_id: 'booking_12345',
        },
      });

      await service.sendBookingNotification(bookingInfo);

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('预约成功！面试时间已确认');
      expect(cardContent).toContain('booking_12345');
    });

    it('should handle missing optional fields gracefully', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const minimalBookingInfo: InterviewBookingInfo = {};

      // Should not throw
      const result = await service.sendBookingNotification(minimalBookingInfo);
      expect(result).toBe(true);
    });

    it('should use green card color', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo());

      expect(mockWebhookService.buildCard).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'green',
        expect.any(Array),
      );
    });

    it('should include notification time in the card content', async () => {
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo());

      const cardContent = mockWebhookService.buildCard.mock.calls[0][1] as string;
      expect(cardContent).toContain('通知时间');
    });
  });
});
