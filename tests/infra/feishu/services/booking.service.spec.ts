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
      buildCardWithAtAll: jest.fn(),
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
      mockWebhookService.buildCardWithAtAll.mockReturnValue(mockCard);
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const bookingInfo = buildBookingInfo();
      const result = await service.sendBookingNotification(bookingInfo);

      expect(result).toBe(true);
      expect(mockWebhookService.buildCardWithAtAll).toHaveBeenCalledWith(
        '🎉 面试预约成功',
        expect.stringContaining('**候选人信息**'),
        'green',
      );
      expect(mockWebhookService.sendMessage).toHaveBeenCalledWith('INTERVIEW_BOOKING', mockCard);
    });

    it('should send failure notification with red card when tool output indicates failure', async () => {
      const mockCard = { msg_type: 'interactive', card: {} };
      mockWebhookService.buildCardWithAtAll.mockReturnValue(mockCard);
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const bookingInfo = buildBookingInfo({
        toolOutput: {
          success: false,
          message: '预约失败',
          error: '该时间段已满',
          errorList: ['请更换时间'],
        },
      });

      const result = await service.sendBookingNotification(bookingInfo);

      expect(result).toBe(true);
      expect(mockWebhookService.buildCardWithAtAll).toHaveBeenCalledWith(
        '⚠️ 面试预约失败',
        expect.stringContaining('**失败详情**'),
        'red',
      );
    });

    it('should return false when sendMessage returns false', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(false);

      const result = await service.sendBookingNotification(buildBookingInfo());
      expect(result).toBe(false);
    });

    it('should return false when sendMessage throws an error', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockRejectedValue(new Error('Network error'));

      const result = await service.sendBookingNotification(buildBookingInfo());
      expect(result).toBe(false);
    });

    it('should include candidateName in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ candidateName: '李四' }));

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('候选人信息');
      expect(cardContent).toContain('李四');
    });

    it('should include brandName in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ brandName: '必胜客' }));

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('面试安排');
      expect(cardContent).toContain('必胜客');
    });

    it('should include storeName in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ storeName: '南京西路店' }));

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('南京西路店');
    });

    it('should include interviewTime in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(
        buildBookingInfo({ interviewTime: '2026-03-20 10:00' }),
      );

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('2026-03-20 10:00');
    });

    it('should mask contactInfo in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ contactInfo: '15612345678' }));

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('156****5678');
      expect(cardContent).not.toContain('15612345678');
    });

    it('should not include chatId in the card content (removed as internal debug info)', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo({ chatId: 'chat_xyz' }));

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).not.toContain('chat_xyz');
    });

    it('should include bookingId in interview section when provided', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const bookingInfo = buildBookingInfo({
        toolOutput: {
          message: '预约成功！面试时间已确认',
          booking_id: 'booking_12345',
        },
      });

      await service.sendBookingNotification(bookingInfo);

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('预约编号：booking_12345');
    });

    it('should include failure details when tool output indicates failure', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(
        buildBookingInfo({
          toolOutput: {
            success: false,
            message: '预约失败',
            error: '该时间段已满',
            errorList: ['请更换时间', { code: 'FULL' }],
          },
        }),
      );

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('原因：该时间段已满');
      expect(cardContent).toContain('明细：请更换时间');
      expect(cardContent).toContain('FULL');
    });

    it('should handle missing optional fields gracefully', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const minimalBookingInfo: InterviewBookingInfo = {};

      // Should not throw
      const result = await service.sendBookingNotification(minimalBookingInfo);
      expect(result).toBe(true);
    });

    it('should use green card color', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo());

      expect(mockWebhookService.buildCardWithAtAll).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'green',
      );
    });

    it('should include notification time in the card content', async () => {
      mockWebhookService.buildCardWithAtAll.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendBookingNotification(buildBookingInfo());

      const cardContent = mockWebhookService.buildCardWithAtAll.mock.calls[0][1] as string;
      expect(cardContent).toContain('通知时间');
    });
  });
});
