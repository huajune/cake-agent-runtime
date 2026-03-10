import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentReplyConfig, DEFAULT_AGENT_REPLY_CONFIG } from '@supabase';
import { SystemConfigService } from '@supabase/config';
import { TypingDelayService } from './message-typing-delay.service';
import {
  TYPING_MIN_DELAY_MS,
  TYPING_MAX_DELAY_MS,
  TYPING_RANDOM_VARIATION,
} from '@core/config/constants/message.constants';

describe('TypingDelayService', () => {
  let service: TypingDelayService;
  let configCallback: (config: AgentReplyConfig) => void;

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockSystemConfigService = {
    getAgentReplyConfig: jest.fn(),
    onAgentReplyConfigChange: jest.fn((cb) => {
      configCallback = cb;
    }),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    configCallback = undefined as any;

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TypingDelayService,
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: SystemConfigService,
          useValue: mockSystemConfigService,
        },
      ],
    }).compile();

    service = module.get<TypingDelayService>(TypingDelayService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('initialization', () => {
    it('should initialize with default constants', () => {
      const stats = service.getStats();
      expect(stats.minDelay).toBe(TYPING_MIN_DELAY_MS);
      expect(stats.maxDelay).toBe(TYPING_MAX_DELAY_MS);
      expect(stats.randomVariation).toBe(TYPING_RANDOM_VARIATION);
      expect(stats.baseTypingSpeed).toBe(8); // Default hardcoded in constructor
    });

    it('should load config from Supabase on module init', async () => {
      const mockConfig: Partial<AgentReplyConfig> = {
        typingSpeedCharsPerSec: 20,
      };
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(mockConfig);

      await service.onModuleInit();

      const stats = service.getStats();
      expect(stats.baseTypingSpeed).toBe(20);
    });

    it('should handle legacy config from Supabase', async () => {
      const mockConfig: Partial<AgentReplyConfig> = {
        typingDelayPerCharMs: 50, // 1000 / 50 = 20 chars/sec
      };
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue(mockConfig);

      await service.onModuleInit();

      const stats = service.getStats();
      expect(stats.baseTypingSpeed).toBe(20);
    });
  });

  describe('calculateDelay', () => {
    beforeEach(() => {
      const mockConfig: Partial<AgentReplyConfig> = {
        typingSpeedCharsPerSec: 10,
      };

      // Trigger config update via callback
      if (configCallback) {
        configCallback({ ...DEFAULT_AGENT_REPLY_CONFIG, ...mockConfig });
      }
    });

    it('should calculate base delay correctly', () => {
      const text = '1234567890'; // 10 chars
      // Base delay = 10 chars / 10 chars/sec = 1s = 1000ms
      // Variation is ±20%, so result should be between 800ms and 1200ms
      const delay = service.calculateDelay(text);
      expect(delay).toBeGreaterThanOrEqual(800);
      expect(delay).toBeLessThanOrEqual(1200);
    });

    it('should respect min and max delay', () => {
      // Very short text
      const shortText = 'a';
      const shortDelay = service.calculateDelay(shortText);
      expect(shortDelay).toBeGreaterThanOrEqual(TYPING_MIN_DELAY_MS);

      // Very long text
      const longText = 'a'.repeat(1000);
      const longDelay = service.calculateDelay(longText);
      expect(longDelay).toBeLessThanOrEqual(TYPING_MAX_DELAY_MS);
    });

    it('should not add thinking time for first segment', () => {
      const text = 'test';
      // Base delay ~400ms
      // Thinking time removed
      // Total should be just typing delay (~400ms ±20%) + clamped to min delay (800ms)
      const delay = service.calculateDelay(text, true);
      expect(delay).toBeLessThan(1500);
    });

    it('should compensate if agent processing was fast', () => {
      const text = 'test';
      const agentTime = 500; // Fast processing
      const delay = service.calculateDelay(text, true, agentTime);

      // Should add compensation to reach ~3s total wait
      // 2000 - 500 = 1500ms compensation
      // Plus typing delay
      expect(delay).toBeGreaterThan(1400);
    });

    it('should not add extra delay if agent processing was slow', () => {
      const text = 'test';
      const agentTime = 5000; // Slow processing (>3s)
      const delay = service.calculateDelay(text, true, agentTime);

      // Should be 0 or very small (just typing delay might be skipped or reduced logic)
      // The logic says: if agentProcessTime >= 3000, delay = 0
      expect(delay).toBe(0);
    });
  });
});
