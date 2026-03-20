import { Test, TestingModule } from '@nestjs/testing';
import { BookingDetectionService } from '@wecom/message/services/booking-detection.service';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';
import { BookingService } from '@biz/message/services/booking.service';

describe('BookingDetectionService', () => {
  let service: BookingDetectionService;

  const mockFeishuBookingService = {
    sendBookingNotification: jest.fn(),
  };

  const mockBookingService = {
    incrementBookingCount: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BookingDetectionService,
        { provide: FeishuBookingService, useValue: mockFeishuBookingService },
        { provide: BookingService, useValue: mockBookingService },
      ],
    }).compile();

    service = module.get<BookingDetectionService>(BookingDetectionService);
    jest.clearAllMocks();

    mockFeishuBookingService.sendBookingNotification.mockResolvedValue(undefined);
    mockBookingService.incrementBookingCount.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('detectBookingSuccess', () => {
    it('should detect booking success keyword "预约成功"', () => {
      const result = service.detectBookingSuccess('好的，面试预约成功，时间为明天下午2点');
      expect(result.detected).toBe(true);
    });

    it('should detect booking success keyword "面试预约已创建"', () => {
      const result = service.detectBookingSuccess('面试预约已创建，请准时参加');
      expect(result.detected).toBe(true);
    });

    it('should detect booking success keyword "booking_id"', () => {
      const result = service.detectBookingSuccess('{"booking_id":"BK-123","status":"created"}');
      expect(result.detected).toBe(true);
    });

    it('should return detected=false for failure keywords', () => {
      const result = service.detectBookingSuccess('预约失败，该时间段已满');
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for regular text', () => {
      const result = service.detectBookingSuccess('您好，请问有什么可以帮您的？');
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for undefined input', () => {
      const result = service.detectBookingSuccess(undefined);
      expect(result.detected).toBe(false);
    });

    it('should return detected=false for empty string', () => {
      const result = service.detectBookingSuccess('');
      expect(result.detected).toBe(false);
    });

    it('should prioritize failure keywords over success keywords', () => {
      const result = service.detectBookingSuccess('预约失败，预约成功的条件不满足');
      expect(result.detected).toBe(false);
    });
  });

  describe('handleBookingSuccessAsync', () => {
    const baseParams = {
      chatId: 'chat-123',
      contactName: 'Alice',
      userId: 'user-123',
      managerId: 'manager-123',
      managerName: 'Bob',
    };

    it('should do nothing when no booking detected', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        replyText: '您好，有什么可以帮您的？',
      });

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
      expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should do nothing when replyText is undefined', async () => {
      await service.handleBookingSuccessAsync({ ...baseParams, replyText: undefined });

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
    });

    it('should trigger async notification and stats update on detected booking', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        replyText: '面试预约成功，时间为明天下午2点',
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'chat-123',
          userId: 'user-123',
          managerId: 'manager-123',
          managerName: 'Bob',
          candidateName: 'Alice',
        }),
      );
      expect(mockBookingService.incrementBookingCount).toHaveBeenCalled();
    });

    it('should handle feishu notification failure gracefully', async () => {
      mockFeishuBookingService.sendBookingNotification.mockRejectedValue(
        new Error('Feishu API error'),
      );

      await service.handleBookingSuccessAsync({
        ...baseParams,
        replyText: '预约成功',
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalled();
    });

    it('should handle booking stats update failure gracefully', async () => {
      mockBookingService.incrementBookingCount.mockRejectedValue(new Error('DB error'));

      await service.handleBookingSuccessAsync({
        ...baseParams,
        replyText: '预约成功',
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockBookingService.incrementBookingCount).toHaveBeenCalled();
    });
  });
});
