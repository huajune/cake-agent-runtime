import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { FeishuWebhookService } from './feishu-webhook.service';

// We test buildCard and buildCardWithAtAll (pure functions) separately from sendMessage
// For sendMessage, we spy on the private httpClient

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

    it('should use INTERVIEW_BOOKING env keys for INTERVIEW_BOOKING type', async () => {
      mockConfigService.get.mockImplementation((key: string, defaultValue?: string) => {
        if (key === 'INTERVIEW_BOOKING_WEBHOOK_URL') return 'https://open.feishu.cn/hook/booking';
        if (key === 'INTERVIEW_BOOKING_WEBHOOK_SECRET') return '';
        return defaultValue;
      });

      const httpClientSpy = jest
        .spyOn(service['httpClient'], 'post')
        .mockResolvedValue({ data: { code: 0 } } as any);

      await service.sendMessage('INTERVIEW_BOOKING', { msg_type: 'interactive' });

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

  describe('buildCard', () => {
    it('should build a card with correct structure', () => {
      const card = service.buildCard('Test Title', 'Test content', 'blue');

      expect(card).toHaveProperty('msg_type', 'interactive');
      expect(card).toHaveProperty('card');

      const cardData = card.card as Record<string, unknown>;
      const header = cardData.header as Record<string, unknown>;
      expect(header.template).toBe('blue');

      const title = header.title as Record<string, unknown>;
      expect(title.content).toBe('Test Title');
    });

    it('should build a card with green color', () => {
      const card = service.buildCard('Alert', 'Content', 'green');
      const cardData = card.card as Record<string, unknown>;
      const header = cardData.header as Record<string, unknown>;
      expect(header.template).toBe('green');
    });

    it('should include markdown content element', () => {
      const card = service.buildCard('Title', 'Markdown **content**', 'blue');
      const cardData = card.card as Record<string, unknown>;
      const elements = cardData.elements as Array<Record<string, unknown>>;
      expect(elements[0].tag).toBe('markdown');
      expect(elements[0].content).toBe('Markdown **content**');
    });

    it('should add @ section when atUsers are provided', () => {
      const atUsers = [
        { openId: 'ou_001', name: '艾酱' },
        { openId: 'ou_002', name: '琪琪' },
      ];
      const card = service.buildCard('Title', 'Content', 'blue', atUsers);
      const cardData = card.card as Record<string, unknown>;
      const elements = cardData.elements as Array<Record<string, unknown>>;

      // Should have markdown + hr + div for at users
      expect(elements.length).toBe(3);
      expect(elements[1].tag).toBe('hr');
      expect(elements[2].tag).toBe('div');

      const divText = (elements[2].text as Record<string, unknown>).content as string;
      expect(divText).toContain('ou_001');
      expect(divText).toContain('ou_002');
    });

    it('should not add @ section when no atUsers', () => {
      const card = service.buildCard('Title', 'Content', 'blue');
      const cardData = card.card as Record<string, unknown>;
      const elements = cardData.elements as Array<Record<string, unknown>>;
      expect(elements.length).toBe(1);
    });

    it('should enable wide screen mode', () => {
      const card = service.buildCard('Title', 'Content');
      const cardData = card.card as Record<string, unknown>;
      const config = cardData.config as Record<string, unknown>;
      expect(config.wide_screen_mode).toBe(true);
    });

    it('should default to blue color when not specified', () => {
      const card = service.buildCard('Title', 'Content');
      const cardData = card.card as Record<string, unknown>;
      const header = cardData.header as Record<string, unknown>;
      expect(header.template).toBe('blue');
    });
  });

  describe('buildCardWithAtAll', () => {
    it('should build a card with at all', () => {
      const card = service.buildCardWithAtAll('Alert', 'Critical error detected', 'red');

      expect(card).toHaveProperty('msg_type', 'interactive');
      const cardData = card.card as Record<string, unknown>;
      const header = cardData.header as Record<string, unknown>;
      expect(header.template).toBe('red');

      const elements = cardData.elements as Array<Record<string, unknown>>;
      expect(elements.length).toBe(3); // markdown + hr + div with @all
      expect(elements[1].tag).toBe('hr');

      const divText = (elements[2].text as Record<string, unknown>).content as string;
      expect(divText).toContain('<at id=all></at>');
    });

    it('should include the provided content in markdown element', () => {
      const card = service.buildCardWithAtAll('Title', 'Important message', 'yellow');
      const cardData = card.card as Record<string, unknown>;
      const elements = cardData.elements as Array<Record<string, unknown>>;
      expect(elements[0].content).toBe('Important message');
    });
  });
});
