import { Test, TestingModule } from '@nestjs/testing';
import { FeishuController } from '@infra/feishu/feishu.controller';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { FeishuBookingService } from '@infra/feishu/services/booking.service';
import { ChatRecordSyncService } from '@infra/feishu/services/chat-record.service';

describe('FeishuController', () => {
  let controller: FeishuController;
  let alertService: FeishuAlertService;
  let bookingService: FeishuBookingService;
  let chatRecordSyncService: ChatRecordSyncService;

  const mockAlertService = {
    sendAlert: jest.fn(),
  };

  const mockBookingService = {
    sendBookingNotification: jest.fn(),
  };

  const mockChatRecordSyncService = {
    manualSync: jest.fn(),
    syncByTimeRange: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeishuController],
      providers: [
        { provide: FeishuAlertService, useValue: mockAlertService },
        { provide: FeishuBookingService, useValue: mockBookingService },
        { provide: ChatRecordSyncService, useValue: mockChatRecordSyncService },
      ],
    }).compile();

    controller = module.get<FeishuController>(FeishuController);
    alertService = module.get<FeishuAlertService>(FeishuAlertService);
    bookingService = module.get<FeishuBookingService>(FeishuBookingService);
    chatRecordSyncService = module.get<ChatRecordSyncService>(ChatRecordSyncService);
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

  describe('triggerManualSync', () => {
    it('should trigger manual sync and return result', async () => {
      const syncResult = {
        success: true,
        message: '同步成功，共处理 50 条记录',
        recordCount: 50,
      };

      mockChatRecordSyncService.manualSync.mockResolvedValue(syncResult);

      const result = await controller.triggerManualSync();

      expect(chatRecordSyncService.manualSync).toHaveBeenCalled();
      expect(result).toEqual({
        success: true,
        message: '同步成功，共处理 50 条记录',
        count: 50,
      });
    });

    it('should return zero count when recordCount is undefined', async () => {
      const syncResult = {
        success: true,
        message: '无新数据需要同步',
      };

      mockChatRecordSyncService.manualSync.mockResolvedValue(syncResult);

      const result = await controller.triggerManualSync();

      expect(result.count).toBe(0);
    });

    it('should handle sync failure and return error response', async () => {
      mockChatRecordSyncService.manualSync.mockRejectedValue(new Error('Sync service error'));

      const result = await controller.triggerManualSync();

      expect(result).toEqual({
        success: false,
        message: '同步失败: Sync service error',
        count: 0,
      });
    });

    it('should handle sync service returning failure', async () => {
      const syncResult = {
        success: false,
        message: '同步失败',
        recordCount: 0,
      };

      mockChatRecordSyncService.manualSync.mockResolvedValue(syncResult);

      const result = await controller.triggerManualSync();

      expect(result.success).toBe(false);
    });
  });

  describe('syncByDateRange', () => {
    it('should sync data for valid date range', async () => {
      const body = { startDate: '2024-01-01', endDate: '2024-01-07' };
      const mockResult = {
        success: true,
        message: '同步成功',
        recordCount: 200,
      };

      mockChatRecordSyncService.syncByTimeRange.mockResolvedValue(mockResult);

      const result = await controller.syncByDateRange(body);

      expect(chatRecordSyncService.syncByTimeRange).toHaveBeenCalledWith(
        expect.any(Number),
        expect.any(Number),
      );
      expect(result).toEqual(mockResult);
    });

    it('should return error when startDate is missing', async () => {
      const body = { startDate: '', endDate: '2024-01-07' };

      const result = await controller.syncByDateRange(body);

      expect(chatRecordSyncService.syncByTimeRange).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        message: '请提供 startDate 和 endDate 参数（格式：YYYY-MM-DD）',
      });
    });

    it('should return error when endDate is missing', async () => {
      const body = { startDate: '2024-01-01', endDate: '' };

      const result = await controller.syncByDateRange(body);

      expect(chatRecordSyncService.syncByTimeRange).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
    });

    it('should return error when date format is invalid', async () => {
      const body = { startDate: 'invalid-date', endDate: 'also-invalid' };

      const result = await controller.syncByDateRange(body);

      expect(chatRecordSyncService.syncByTimeRange).not.toHaveBeenCalled();
      expect(result).toEqual({
        success: false,
        message: '日期格式错误，请使用 YYYY-MM-DD 格式',
      });
    });

    it('should handle sync service error gracefully', async () => {
      const body = { startDate: '2024-01-01', endDate: '2024-01-07' };
      mockChatRecordSyncService.syncByTimeRange.mockRejectedValue(new Error('Sync failed'));

      const result = await controller.syncByDateRange(body);

      expect(result.success).toBe(false);
      expect(result.message).toContain('同步失败');
    });

    it('should calculate correct timestamp range (CST timezone)', async () => {
      const body = { startDate: '2024-01-01', endDate: '2024-01-01' };
      mockChatRecordSyncService.syncByTimeRange.mockResolvedValue({ success: true });

      await controller.syncByDateRange(body);

      const callArgs = mockChatRecordSyncService.syncByTimeRange.mock.calls[0];
      const startTimestamp = callArgs[0];
      const endTimestamp = callArgs[1];

      // start should be beginning of day in CST (UTC+8): 2024-01-01T00:00:00+08:00
      // = 2023-12-31T16:00:00Z
      expect(startTimestamp).toBe(new Date('2024-01-01T00:00:00+08:00').getTime());

      // end should be end of day in CST: 2024-01-01T23:59:59+08:00
      expect(endTimestamp).toBe(new Date('2024-01-01T23:59:59+08:00').getTime());
    });
  });
});
