import { Test, TestingModule } from '@nestjs/testing';
import { FeishuController } from '@infra/feishu/feishu.controller';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';

describe('FeishuController', () => {
  let controller: FeishuController;
  let alertService: FeishuAlertService;

  const mockAlertService = {
    sendAlert: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeishuController],
      providers: [{ provide: FeishuAlertService, useValue: mockAlertService }],
    }).compile();

    controller = module.get<FeishuController>(FeishuController);
    alertService = module.get<FeishuAlertService>(FeishuAlertService);
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
});
