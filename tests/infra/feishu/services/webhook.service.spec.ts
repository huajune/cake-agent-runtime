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

    it('should honor an explicitly empty secret instead of falling back to the default secret', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_URL') {
          return 'https://open.feishu.cn/hook/booking';
        }
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_SECRET') {
          return '';
        }
        return defaultValue;
      });

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('MESSAGE_NOTIFICATION', { msg_type: 'interactive' });

      const calledPayload = httpClientSpy.mock.calls[0][1] as Record<string, unknown>;
      expect(calledPayload).not.toHaveProperty('sign');
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
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_URL')
          return 'https://open.feishu.cn/hook/booking';
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

  describe('sendMessage retry & failure alert', () => {
    const PRIVATE_URL = 'https://open.feishu.cn/hook/private';
    const ALERT_URL = 'https://open.feishu.cn/hook/alert';

    const axiosError = (status: number) =>
      Object.assign(new Error(`HTTP ${status}`), {
        isAxiosError: true,
        response: { status, data: { error: status } },
      });

    beforeEach(() => {
      // 重试退避用 sleep；测试里直接短路，避免真实等待
      jest.spyOn(service as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue();
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'PRIVATE_CHAT_MONITOR_WEBHOOK_URL') return PRIVATE_URL;
        if (key === 'FEISHU_ALERT_WEBHOOK_URL') return ALERT_URL;
        if (key.endsWith('_SECRET')) return '';
        return defaultValue;
      });
    });

    it('retries on a retryable (5xx) error and succeeds on a later attempt', async () => {
      const postSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockRejectedValueOnce(axiosError(503) as never)
        .mockResolvedValueOnce({ data: { code: 0 } } as never);

      const result = await service.sendMessage('PRIVATE_CHAT_MONITOR', { msg_type: 'interactive' });

      expect(result).toBe(true);
      expect(postSpy).toHaveBeenCalledTimes(2);
    });

    it('does NOT retry on a non-retryable (4xx) error', async () => {
      const postSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockImplementation((url: string) =>
          url === ALERT_URL
            ? (Promise.resolve({ data: { code: 0 } }) as never)
            : (Promise.reject(axiosError(400)) as never),
        );

      const result = await service.sendMessage('PRIVATE_CHAT_MONITOR', { msg_type: 'interactive' });

      expect(result).toBe(false);
      // 业务通道只尝试 1 次（无重试），另有 1 次是失败告警补发到 ALERT
      const businessCalls = postSpy.mock.calls.filter(([url]) => url === PRIVATE_URL);
      expect(businessCalls).toHaveLength(1);
    });

    it('gives up after MAX attempts on persistent retryable error and posts a failure alert', async () => {
      const postSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockImplementation((url: string) =>
          url === ALERT_URL
            ? (Promise.resolve({ data: { code: 0 } }) as never)
            : (Promise.reject(axiosError(503)) as never),
        );

      const result = await service.sendMessage('PRIVATE_CHAT_MONITOR', { msg_type: 'interactive' });

      expect(result).toBe(false);
      const businessCalls = postSpy.mock.calls.filter(([url]) => url === PRIVATE_URL);
      expect(businessCalls).toHaveLength(3); // MAX_SEND_ATTEMPTS

      // 终态失败后向告警群补发一条可见告警
      const alertCall = postSpy.mock.calls.find(([url]) => url === ALERT_URL);
      expect(alertCall).toBeDefined();
      const alertCard = alertCall?.[1] as { card?: { header?: { title?: { content?: string } } } };
      expect(alertCard?.card?.header?.title?.content).toContain('飞书通知发送失败');
    });

    it('does not recursively alert when the ALERT channel itself fails', async () => {
      const postSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockRejectedValue(axiosError(503) as never);

      const result = await service.sendMessage('ALERT', { msg_type: 'text' });

      expect(result).toBe(false);
      // ALERT 通道自身失败：只重试 3 次，绝不再向 ALERT 递归补发
      expect(postSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('sendMessageOrThrow', () => {
    it('should throw when feishu API returns a non-zero code', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_URL') return 'https://open.feishu.cn/hook/test';
        if (key === 'MESSAGE_NOTIFICATION_WEBHOOK_SECRET') return '';
        return defaultValue;
      });

      jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 19001, msg: 'sign error' } } as any);

      await expect(
        service.sendMessageOrThrow('MESSAGE_NOTIFICATION', { msg_type: 'interactive' }),
      ).rejects.toThrow('飞书 API 返回错误');
    });
  });
});
