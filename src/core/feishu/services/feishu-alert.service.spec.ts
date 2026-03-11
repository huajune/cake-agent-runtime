import { Test, TestingModule } from '@nestjs/testing';
import { FeishuAlertService } from './feishu-alert.service';
import { FeishuWebhookService } from './feishu-webhook.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { AlertLevel } from '../interfaces/feishu.interface';
import { DEFAULT_AGENT_REPLY_CONFIG } from '@biz/hosting-config/types/hosting-config.types';

describe('FeishuAlertService', () => {
  let service: FeishuAlertService;

  // Store the onAgentReplyConfigChange callback to simulate config changes
  let configChangeCallback: ((config: typeof DEFAULT_AGENT_REPLY_CONFIG) => void) | null = null;

  const mockWebhookService = {
    buildCard: jest.fn(),
    buildCardWithAtAll: jest.fn(),
    sendMessage: jest.fn(),
  };

  const mockSystemConfigService = {
    getAgentReplyConfig: jest.fn(),
    onAgentReplyConfigChange: jest.fn((cb) => {
      configChangeCallback = cb;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    configChangeCallback = null;

    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);
    mockWebhookService.buildCard.mockReturnValue({ msg_type: 'interactive', card: {} });
    mockWebhookService.buildCardWithAtAll.mockReturnValue({ msg_type: 'interactive', card: {} });
    mockWebhookService.sendMessage.mockResolvedValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeishuAlertService,
        { provide: FeishuWebhookService, useValue: mockWebhookService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    }).compile();

    service = module.get<FeishuAlertService>(FeishuAlertService);

    // Reset throttle map so each test starts fresh
    (service as any).throttleMap.clear();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== onModuleInit ====================

  describe('onModuleInit', () => {
    it('should load throttle config from Supabase on init', async () => {
      const customConfig = {
        ...DEFAULT_AGENT_REPLY_CONFIG,
        alertThrottleWindowMs: 10 * 60 * 1000,
        alertThrottleMaxCount: 5,
      };
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(customConfig);

      await service.onModuleInit();

      expect(mockSystemConfigService.getAgentReplyConfig).toHaveBeenCalled();
      expect((service as any).throttleWindowMs).toBe(10 * 60 * 1000);
      expect((service as any).throttleMaxCount).toBe(5);
    });

    it('should handle Supabase load failure gracefully', async () => {
      mockSystemConfigService.getAgentReplyConfig.mockRejectedValue(new Error('Supabase error'));

      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  // ==================== sendAlert ====================

  describe('sendAlert', () => {
    it('should send alert successfully', async () => {
      const mockCard = { msg_type: 'interactive' };
      mockWebhookService.buildCard.mockReturnValue(mockCard);
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const result = await service.sendAlert({
        errorType: 'agent_timeout',
        error: new Error('Timeout'),
        conversationId: 'conv-123',
      });

      expect(result).toBe(true);
      expect(mockWebhookService.sendMessage).toHaveBeenCalledWith('ALERT', mockCard);
    });

    it('should use default error title based on errorType', async () => {
      await service.sendAlert({ errorType: 'agent_timeout' });

      // buildCard called with (title, content, color) - 3 args without atUsers
      const [title, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(title).toContain('超时');
      expect(color).toBe('red'); // default level is ERROR = red
    });

    it('should use custom title when provided', async () => {
      await service.sendAlert({ errorType: 'custom', title: 'Custom Title', message: 'msg' });

      const [title] = mockWebhookService.buildCard.mock.calls[0];
      expect(title).toBe('Custom Title');
    });

    it('should use INFO color for info level alert', async () => {
      await service.sendAlert({ errorType: 'system', level: AlertLevel.INFO });

      const [, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(color).toBe('blue');
    });

    it('should use yellow color for warning level', async () => {
      await service.sendAlert({ errorType: 'system', level: AlertLevel.WARNING });

      const [, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(color).toBe('yellow');
    });

    it('should use red color for error level (default)', async () => {
      await service.sendAlert({ errorType: 'system' });

      const [, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(color).toBe('red');
    });

    it('should use red color for critical level', async () => {
      await service.sendAlert({ errorType: 'system', level: AlertLevel.CRITICAL });

      const [, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(color).toBe('red');
    });

    it('should build card with atUsers when atUsers is provided', async () => {
      const atUsers = [{ openId: 'ou_123', name: 'Alice' }];

      await service.sendAlert({
        errorType: 'delivery',
        atUsers,
        contactName: 'Bob',
        userMessage: 'Hello',
        fallbackMessage: 'Sorry',
      });

      expect(mockWebhookService.buildCard).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        expect.any(String),
        atUsers,
      );
      expect(mockWebhookService.buildCardWithAtAll).not.toHaveBeenCalled();
    });

    it('should build card with atAll when atAll is true', async () => {
      await service.sendAlert({ errorType: 'system', atAll: true });

      expect(mockWebhookService.buildCardWithAtAll).toHaveBeenCalled();
      expect(mockWebhookService.buildCard).not.toHaveBeenCalled();
    });

    it('should build normal card when no @ directives provided', async () => {
      await service.sendAlert({ errorType: 'system' });

      // Without atUsers, buildCard is called with 3 args (no 4th atUsers arg)
      expect(mockWebhookService.buildCard).toHaveBeenCalledTimes(1);
      expect(mockWebhookService.buildCardWithAtAll).not.toHaveBeenCalled();
    });

    it('should return false and not send when throttled', async () => {
      // Set throttleMaxCount to 2 for this test
      (service as any).throttleMaxCount = 2;

      await service.sendAlert({ errorType: 'test_throttle_error' });
      await service.sendAlert({ errorType: 'test_throttle_error' });

      jest.clearAllMocks();
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      // This 3rd call within the window should be throttled (maxCount is 2)
      const result = await service.sendAlert({ errorType: 'test_throttle_error' });

      expect(result).toBe(false);
      expect(mockWebhookService.sendMessage).not.toHaveBeenCalled();
    });

    it('should throttle separately by errorType:scenario combination', async () => {
      (service as any).throttleMaxCount = 2;

      // Fill quota for errorType 'agent' with scenario 'chat'
      await service.sendAlert({ errorType: 'agent_scenario', scenario: 'chat' });
      await service.sendAlert({ errorType: 'agent_scenario', scenario: 'chat' });

      jest.clearAllMocks();
      mockWebhookService.buildCard.mockReturnValue({});
      mockWebhookService.sendMessage.mockResolvedValue(true);

      // Different scenario should not be throttled
      const result = await service.sendAlert({ errorType: 'agent_scenario', scenario: 'send' });

      expect(result).toBe(true);
    });

    it('should return false when webhook sendMessage fails', async () => {
      mockWebhookService.sendMessage.mockResolvedValue(false);

      const result = await service.sendAlert({ errorType: 'system_error_unique' });

      expect(result).toBe(false);
    });

    it('should handle webhook send exception gracefully', async () => {
      mockWebhookService.sendMessage.mockRejectedValue(new Error('Network error'));

      const result = await service.sendAlert({ errorType: 'system_exc_unique' });

      expect(result).toBe(false);
    });

    it('should include relevant fields in card content', async () => {
      let cardContent = '';
      mockWebhookService.buildCard.mockImplementation((title: string, content: string) => {
        cardContent = content;
        return {};
      });

      await service.sendAlert({
        errorType: 'agent',
        error: new Error('API failed'),
        conversationId: 'conv-abc',
        userMessage: 'Hello there',
        apiEndpoint: '/api/v1/chat',
        scenario: 'direct_chat',
      });

      expect(cardContent).toContain('conv-abc');
      expect(cardContent).toContain('Hello there');
      expect(cardContent).toContain('/api/v1/chat');
      expect(cardContent).toContain('direct_chat');
    });

    it('should truncate long userMessage in card content', async () => {
      let cardContent = '';
      mockWebhookService.buildCard.mockImplementation((title: string, content: string) => {
        cardContent = content;
        return {};
      });

      const longMessage = 'A'.repeat(200);

      await service.sendAlert({
        errorType: 'agent_trunc',
        userMessage: longMessage,
      });

      // Should be truncated (max 100 chars + '...')
      expect(cardContent).toContain('...');
    });

    it('should show fallback alert format when atUsers is provided', async () => {
      let cardContent = '';
      mockWebhookService.buildCard.mockImplementation(
        (title: string, content: string, _color: string, _atUsers: unknown) => {
          cardContent = content;
          return {};
        },
      );

      await service.sendAlert({
        errorType: 'delivery',
        atUsers: [{ openId: 'ou_123', name: 'Alice' }],
        contactName: '候选人',
        userMessage: '用户的消息',
        fallbackMessage: '降级回复',
        error: new Error('花卷错误'),
      });

      // Fallback format shows contactName first
      expect(cardContent).toContain('候选人');
      expect(cardContent).toContain('用户的消息');
      expect(cardContent).toContain('降级回复');
    });

    it('should use fallback title when errorType is not in known titles', async () => {
      await service.sendAlert({ errorType: 'unknown_custom_type' });

      const [title] = mockWebhookService.buildCard.mock.calls[0];
      expect(title).toContain('⚠️');
    });
  });

  // ==================== sendSimpleAlert ====================

  describe('sendSimpleAlert', () => {
    it('should call sendAlert with info level and blue color', async () => {
      mockWebhookService.sendMessage.mockResolvedValue(true);

      const result = await service.sendSimpleAlert('Test Title', 'Test message', 'info');

      expect(result).toBe(true);
      const [title, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(title).toBe('Test Title');
      expect(color).toBe('blue'); // info maps to blue
    });

    it('should use error level (red) when not provided', async () => {
      mockWebhookService.sendMessage.mockResolvedValue(true);

      await service.sendSimpleAlert('Title', 'Message');

      const [, , color] = mockWebhookService.buildCard.mock.calls[0];
      expect(color).toBe('red'); // default error = red
    });

    it('should include the message in card content', async () => {
      mockWebhookService.sendMessage.mockResolvedValue(true);

      let cardContent = '';
      mockWebhookService.buildCard.mockImplementation((title: string, content: string) => {
        cardContent = content;
        return {};
      });

      await service.sendSimpleAlert('Title', 'My special message', 'warning');

      expect(cardContent).toContain('My special message');
    });
  });

  // ==================== config change callback ====================

  describe('config change callback', () => {
    it('should register a callback with systemConfigService', () => {
      expect(mockSystemConfigService.onAgentReplyConfigChange).toHaveBeenCalledTimes(1);
      expect(configChangeCallback).not.toBeNull();
    });

    it('should update throttle config when config changes', () => {
      const newConfig = {
        ...DEFAULT_AGENT_REPLY_CONFIG,
        alertThrottleWindowMs: 10 * 60 * 1000,
        alertThrottleMaxCount: 5,
      };

      configChangeCallback!(newConfig);

      expect((service as any).throttleWindowMs).toBe(10 * 60 * 1000);
      expect((service as any).throttleMaxCount).toBe(5);
    });

    it('should not throw when config values are unchanged', () => {
      const sameConfig = {
        ...DEFAULT_AGENT_REPLY_CONFIG,
        alertThrottleWindowMs: (service as any).throttleWindowMs,
        alertThrottleMaxCount: (service as any).throttleMaxCount,
      };

      expect(() => configChangeCallback!(sameConfig)).not.toThrow();
    });
  });
});
