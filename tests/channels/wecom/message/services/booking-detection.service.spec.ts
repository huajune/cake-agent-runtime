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

    mockFeishuBookingService.sendBookingNotification.mockResolvedValue(true);
    mockBookingService.incrementBookingCount.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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
      });

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
      expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should do nothing when no interview booking tool call exists', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_job_list',
            args: { cityNameList: ['上海'] },
            result: { jobs: [] },
          },
        ],
      });

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
      expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should do nothing when interview booking tool result has no explicit success field', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { name: '张三' },
            result: { message: '处理中' },
          },
        ],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).not.toHaveBeenCalled();
      expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should trigger notification and stats update from interview booking tool result', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {
              name: '张三',
              phone: '13800138000',
              interviewTime: '2026-04-01 14:00:00',
            },
            result: {
              success: true,
              message: '预约成功',
              booking_id: 'BK-123',
              requestInfo: {
                name: '张三',
                phone: '13800138000',
                interviewTime: '2026-04-01 14:00:00',
              },
            },
          },
        ],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateName: '张三',
          contactInfo: '13800138000',
          interviewTime: '2026-04-01 14:00:00',
          chatId: 'chat-123',
          userId: 'user-123',
          managerId: 'manager-123',
          toolOutput: expect.objectContaining({
            success: true,
            message: '预约成功',
            booking_id: 'BK-123',
          }),
        }),
      );
      expect(mockBookingService.incrementBookingCount).toHaveBeenCalled();
    });

    it('should send feishu notification but skip stats update when interview booking tool fails', async () => {
      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: {
              name: '张三',
              phone: '13800138000',
              interviewTime: '2026-04-01 14:00:00',
            },
            result: {
              success: false,
              message: '预约失败',
              error: '该时间段已满',
              errorList: ['请更换时间'],
            },
          },
        ],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalledWith(
        expect.objectContaining({
          candidateName: '张三',
          contactInfo: '13800138000',
          interviewTime: '2026-04-01 14:00:00',
          toolOutput: expect.objectContaining({
            success: false,
            message: '预约失败',
            error: '该时间段已满',
          }),
        }),
      );
      expect(mockBookingService.incrementBookingCount).not.toHaveBeenCalled();
    });

    it('should handle feishu notification failure gracefully', async () => {
      mockFeishuBookingService.sendBookingNotification.mockRejectedValue(
        new Error('Feishu API error'),
      );

      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { name: '张三' },
            result: { success: true, message: '预约成功' },
          },
        ],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockFeishuBookingService.sendBookingNotification).toHaveBeenCalled();
    });

    it('should handle booking stats update failure gracefully', async () => {
      mockBookingService.incrementBookingCount.mockRejectedValue(new Error('DB error'));

      await service.handleBookingSuccessAsync({
        ...baseParams,
        toolCalls: [
          {
            toolName: 'duliday_interview_booking',
            args: { name: '张三' },
            result: { success: true, message: '预约成功' },
          },
        ],
      });

      await new Promise((resolve) => setImmediate(resolve));

      expect(mockBookingService.incrementBookingCount).toHaveBeenCalled();
    });
  });
});
