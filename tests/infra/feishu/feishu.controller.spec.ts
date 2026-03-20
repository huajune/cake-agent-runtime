import { Test, TestingModule } from '@nestjs/testing';
import { FeishuController } from '@infra/feishu/feishu.controller';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';

describe('FeishuController', () => {
  let controller: FeishuController;
  let alertService: FeishuAlertService;
  let bookingService: FeishuBookingService;

  const mockAlertService = {
    sendAlert: jest.fn(),
  };

  const mockBookingService = {
    sendBookingNotification: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeishuController],
      providers: [
        { provide: FeishuAlertService, useValue: mockAlertService },
        { provide: FeishuBookingService, useValue: mockBookingService },
      ],
    }).compile();

    controller = module.get<FeishuController>(FeishuController);
    alertService = module.get<FeishuAlertService>(FeishuAlertService);
    bookingService = module.get<FeishuBookingService>(FeishuBookingService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendTestAlert', () => {
    it('should send alert and return success when alert is sent', async () => {
      const context = {
        errorType: 'AGENT_API_ERROR',
        error: new Error('Connection failed'),
        conversationId: 'conv-123',
      };

      mockAlertService.sendAlert.mockResolvedValue(true);

      const result = await controller.sendTestAlert(context);

      expect(alertService.sendAlert).toHaveBeenCalledWith(context);
      expect(result).toEqual({
        success: true,
        message: '告警已发送到飞书',
      });
    });

    it('should return failure message when alert is throttled', async () => {
      const context = {
        errorType: 'AGENT_API_ERROR',
        error: 'Rate limit exceeded',
      };

      mockAlertService.sendAlert.mockResolvedValue(false);

      const result = await controller.sendTestAlert(context);

      expect(alertService.sendAlert).toHaveBeenCalledWith(context);
      expect(result).toEqual({
        success: false,
        message: '告警发送失败或被节流',
      });
    });

    it('should handle alert with minimal context', async () => {
      const context = { errorType: 'UNKNOWN_ERROR' };
      mockAlertService.sendAlert.mockResolvedValue(true);

      const result = await controller.sendTestAlert(context);

      expect(result.success).toBe(true);
    });

    it('should propagate errors from alertService', async () => {
      const context = { errorType: 'TEST_ERROR' };
      mockAlertService.sendAlert.mockRejectedValue(new Error('Webhook failed'));

      await expect(controller.sendTestAlert(context)).rejects.toThrow('Webhook failed');
    });
  });

  describe('sendTestBooking', () => {
    it('should send booking notification and return success', async () => {
      const bookingInfo = {
        candidateName: 'Zhang San',
        interviewTime: '2024-01-15 14:00',
        interviewLocation: 'Online',
        contactPhone: '1234567890',
      };

      mockBookingService.sendBookingNotification.mockResolvedValue(true);

      const result = await controller.sendTestBooking(bookingInfo as any);

      expect(bookingService.sendBookingNotification).toHaveBeenCalledWith(bookingInfo);
      expect(result).toEqual({
        success: true,
        message: '预约通知已发送到飞书',
      });
    });

    it('should return failure message when booking notification fails', async () => {
      const bookingInfo = {
        candidateName: 'Li Si',
        interviewTime: '2024-01-16 10:00',
      };

      mockBookingService.sendBookingNotification.mockResolvedValue(false);

      const result = await controller.sendTestBooking(bookingInfo as any);

      expect(result).toEqual({
        success: false,
        message: '预约通知发送失败',
      });
    });

    it('should propagate errors from bookingService', async () => {
      const bookingInfo = { candidateName: 'Wang Wu' };
      mockBookingService.sendBookingNotification.mockRejectedValue(new Error('Webhook error'));

      await expect(controller.sendTestBooking(bookingInfo as any)).rejects.toThrow('Webhook error');
    });
  });
});
