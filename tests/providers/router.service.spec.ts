import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RouterService } from '@providers/router.service';
import { ReliableService } from '@providers/reliable.service';

describe('RouterService', () => {
  let service: RouterService;
  let mockReliable: {
    resolveWithFallback: jest.Mock;
    generateText: jest.Mock;
    streamText: jest.Mock;
  };
  let mockConfigService: { get: jest.Mock };

  const mockModel = { modelId: 'anthropic/claude-sonnet-4-6' };

  function setupConfig(overrides: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
      AGENT_CHAT_MODEL: 'anthropic/claude-sonnet-4-6',
      AGENT_CHAT_FALLBACKS: 'openai/gpt-4o,deepseek/deepseek-chat',
      ...overrides,
    };
    mockConfigService.get.mockImplementation((key: string) => env[key]);
  }

  beforeEach(async () => {
    jest.clearAllMocks();

    mockReliable = {
      resolveWithFallback: jest.fn().mockReturnValue(mockModel),
      generateText: jest.fn().mockResolvedValue({ text: 'response' }),
      streamText: jest.fn().mockReturnValue({ textStream: 'stream' }),
    };

    mockConfigService = {
      get: jest.fn(),
    };

    setupConfig();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RouterService,
        { provide: ReliableService, useValue: mockReliable },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<RouterService>(RouterService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('resolveByRole', () => {
    it('should resolve chat role to configured model with fallbacks', () => {
      const result = service.resolveByRole('chat');
      expect(result).toBe(mockModel);
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
      );
    });

    it('should resolve fast role with default fallbacks when no role-specific fallbacks', () => {
      setupConfig({ AGENT_DEFAULT_FALLBACKS: 'qwen/qwen-max-latest' });
      service.resolveByRole('fast');
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'deepseek/deepseek-chat',
        ['qwen/qwen-max-latest'],
      );
    });

    it('should use role-specific fallbacks over default fallbacks', () => {
      setupConfig({ AGENT_DEFAULT_FALLBACKS: 'qwen/qwen-max-latest' });
      service.resolveByRole('chat');
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
      );
    });

    it('should return undefined fallbacks when neither role-specific nor default configured', () => {
      service.resolveByRole('fast');
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'deepseek/deepseek-chat',
        undefined,
      );
    });

    it('should throw when role is not configured', () => {
      expect(() => service.resolveByRole('unknown')).toThrow(
        '角色 "unknown" 未配置模型',
      );
    });

    it('should be case-insensitive for role names', () => {
      service.resolveByRole('CHAT');
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
      );
    });
  });

  describe('resolve', () => {
    it('should delegate to reliable.resolveWithFallback', () => {
      const result = service.resolve('anthropic/claude-sonnet-4-6', ['openai/gpt-4o']);
      expect(result).toBe(mockModel);
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        ['openai/gpt-4o'],
      );
    });

    it('should work without fallbacks', () => {
      service.resolve('deepseek/deepseek-chat');
      expect(mockReliable.resolveWithFallback).toHaveBeenCalledWith(
        'deepseek/deepseek-chat',
        undefined,
      );
    });
  });

  describe('generateTextByRole', () => {
    it('should call reliable.generateText with role model and fallbacks', async () => {
      const params = { prompt: 'Hello' };
      await service.generateTextByRole('chat', params);

      expect(mockReliable.generateText).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        params,
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
        undefined,
      );
    });

    it('should pass custom config through', async () => {
      const params = { prompt: 'Hello' };
      const config = { maxRetries: 5 };
      await service.generateTextByRole('chat', params, config);

      expect(mockReliable.generateText).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        params,
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
        config,
      );
    });

    it('should throw when role is not configured', async () => {
      await expect(
        service.generateTextByRole('unknown', { prompt: 'Hi' }),
      ).rejects.toThrow('角色 "unknown" 未配置模型');
    });
  });

  describe('streamTextByRole', () => {
    it('should call reliable.streamText with role model and fallbacks', () => {
      const params = { prompt: 'Hello' };
      service.streamTextByRole('chat', params);

      expect(mockReliable.streamText).toHaveBeenCalledWith(
        'anthropic/claude-sonnet-4-6',
        params,
        ['openai/gpt-4o', 'deepseek/deepseek-chat'],
      );
    });

    it('should throw when role is not configured', () => {
      expect(() =>
        service.streamTextByRole('unknown', { prompt: 'Hi' }),
      ).toThrow('角色 "unknown" 未配置模型');
    });
  });

  describe('listRoles', () => {
    it('should list all configured roles', () => {
      const roles = service.listRoles();
      expect(roles).toContain('chat');
      expect(roles).not.toContain('extract');
      expect(roles).not.toContain('vision');
    });

    it('should return empty when no roles configured', () => {
      setupConfig({
        AGENT_CHAT_MODEL: undefined,
      });
      const roles = service.listRoles();
      expect(roles).toEqual([]);
    });

    it('should include vision when configured', () => {
      setupConfig({ AGENT_VISION_MODEL: 'google/gemini-2.0-flash' });
      const roles = service.listRoles();
      expect(roles).toContain('vision');
    });

    it('should include extract and evaluate when configured', () => {
      setupConfig({
        AGENT_EXTRACT_MODEL: 'openai/gpt-4o-mini',
        AGENT_EVALUATE_MODEL: 'anthropic/claude-sonnet-4-6',
      });
      const roles = service.listRoles();
      expect(roles).toContain('extract');
      expect(roles).toContain('evaluate');
    });
  });
});
