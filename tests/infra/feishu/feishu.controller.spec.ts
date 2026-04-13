import { Test, TestingModule } from '@nestjs/testing';
import { FeishuController } from '@infra/feishu/feishu.controller';
import { FeishuCardBuilderService } from '@infra/feishu/services/card-builder.service';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';

describe('FeishuController', () => {
  let controller: FeishuController;
  let webhookService: FeishuWebhookService;
  let cardBuilder: FeishuCardBuilderService;

  const mockWebhookService = {
    sendMessage: jest.fn(),
  };

  const mockCardBuilder = {
    buildMarkdownCard: jest.fn().mockImplementation((payload) => payload),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [FeishuController],
      providers: [
        { provide: FeishuWebhookService, useValue: mockWebhookService },
        { provide: FeishuCardBuilderService, useValue: mockCardBuilder },
      ],
    }).compile();

    controller = module.get<FeishuController>(FeishuController);
    webhookService = module.get<FeishuWebhookService>(FeishuWebhookService);
    cardBuilder = module.get<FeishuCardBuilderService>(FeishuCardBuilderService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendTestAlert', () => {
    it('should send alert and return success when alert is sent', async () => {
      const body = {
        title: '测试告警',
        content: 'Connection failed',
      };

      mockWebhookService.sendMessage.mockResolvedValue(true);

      const result = await controller.sendTestAlert(body);

      expect(cardBuilder.buildMarkdownCard).toHaveBeenCalledWith(
        expect.objectContaining({
          title: '测试告警',
          content: 'Connection failed',
        }),
      );
      expect(webhookService.sendMessage).toHaveBeenCalledWith(
        'ALERT',
        expect.objectContaining({
          title: '测试告警',
          content: 'Connection failed',
        }),
      );
      expect(result).toEqual({
        success: true,
        message: '测试消息已发送到飞书',
      });
    });

    it('should return failure message when sending fails', async () => {
      const body = {
        title: '测试告警',
        content: 'Rate limit exceeded',
      };

      mockWebhookService.sendMessage.mockResolvedValue(false);

      const result = await controller.sendTestAlert(body);

      expect(result).toEqual({
        success: false,
        message: '测试消息发送失败',
      });
    });

    it('should handle alert with minimal context', async () => {
      const body = { title: '最小测试', content: 'hello' };
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const result = await controller.sendTestAlert(body);

      expect(result.success).toBe(true);
    });

    it('should propagate errors from webhookService', async () => {
      const body = { title: '测试异常', content: 'Webhook failed' };
      mockWebhookService.sendMessage.mockRejectedValue(new Error('Webhook failed'));

      await expect(controller.sendTestAlert(body)).rejects.toThrow('Webhook failed');
    });
  });
});
