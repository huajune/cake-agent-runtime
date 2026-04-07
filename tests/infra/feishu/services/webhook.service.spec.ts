import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeishuWebhookService } from '@infra/feishu/services/webhook.service';

describe('FeishuWebhookService', () => {
  let service: FeishuWebhookService;
  let mockConfigService: jest.Mocked<ConfigService>;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn(),
    } as unknown as jest.Mocked<ConfigService>;

    const module: TestingModule = await Test.createTestingModule({
      providers: [FeishuWebhookService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<FeishuWebhookService>(FeishuWebhookService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('sendMessage', () => {
    it('should send message successfully and return true', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'FEISHU_ALERT_SECRET') return '';
        return defaultValue;
      });

      // Spy on the private httpClient
      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0, msg: 'success' } } as any);

      const content = { msg_type: 'text', content: { text: 'test' } };
      const result = await service.sendMessage('ALERT', content);

      expect(result).toBe(true);
      expect(httpClientSpy).toHaveBeenCalledWith(
        'https://open.feishu.cn/hook/test',
        expect.objectContaining({ msg_type: 'text' }),
      );
    });

    it('should return false when URL is not configured', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return '';
        return defaultValue;
      });

      const httpClientSpy = jest.spyOn(service['httpClient'], 'post');

      const result = await service.sendMessage('ALERT', {});

      expect(result).toBe(false);
      expect(httpClientSpy).not.toHaveBeenCalled();
    });

    it('should return false when API returns non-zero code', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'FEISHU_ALERT_SECRET') return '';
        return defaultValue;
      });

      jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 19001, msg: 'sign error' } } as any);

      const result = await service.sendMessage('ALERT', {});

      expect(result).toBe(false);
    });

    it('should return false when HTTP request throws an error', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'FEISHU_ALERT_SECRET') return '';
        return defaultValue;
      });

      jest
        .spyOn(service['httpClient'], 'post')
        .mockRejectedValue(new Error('Network timeout') as never);

      const result = await service.sendMessage('ALERT', {});

      expect(result).toBe(false);
    });

    it('should include signature when secret is configured', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'FEISHU_ALERT_SECRET') return 'my-secret';
        return defaultValue;
      });

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('ALERT', { msg_type: 'text' });

      const calledPayload = httpClientSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(calledPayload).toHaveProperty('timestamp');
      expect(calledPayload).toHaveProperty('sign');
    });

    it('should not include signature when secret is empty', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'FEISHU_ALERT_SECRET') return '';
        return defaultValue;
      });

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('ALERT', { msg_type: 'text' });

      const calledPayload = httpClientSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(calledPayload).not.toHaveProperty('sign');
    });

    it('should use MESSAGE_NOTIFICATION env keys for MESSAGE_NOTIFICATION channel', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_URL') return 'https://open.feishu.cn/hook/booking';
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_SECRET') return '';
        return defaultValue;
      });

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('MESSAGE_NOTIFICATION', { msg_type: 'interactive' });

      expect(httpClientSpy).toHaveBeenCalledWith(
        'https://open.feishu.cn/hook/booking',
        expect.any(Object),
      );
    });

    it('should fall back to default hardcoded URL when env var is absent', async () => {
      // Return defaultValue for all keys (simulates env vars not being set)
      mockConfigService.get.mockImplementation(
        (_key: string, defaultValue?: string) => defaultValue,
      );

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('ALERT', {});

      // Should have called post with the default URL from FEISHU_WEBHOOKS.ALERT.URL
      const calledUrl = httpClientSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('feishu.cn');
    });
  });

});
