import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';

describe('RouterService', () => {
  let service: RouterService;
  let env: Record<string, string | undefined>;
  let mockConfigService: { get: jest.Mock };

  beforeEach(async () => {
    env = {
      AGENT_CHAT_MODEL: 'anthropic/claude-sonnet-4-6',
      AGENT_CHAT_FALLBACKS: 'openai/gpt-4o, deepseek/deepseek-v4-flash',
    };

    mockConfigService = {
      get: jest.fn((key: string) => env[key]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [RouterService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<RouterService>(RouterService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('listRoles', () => {
    it('should list only configured roles', () => {
      env.AGENT_VISION_MODEL = 'google/gemini-2.0-flash';
      env.AGENT_EVALUATE_MODEL = 'openai/gpt-4o-mini';

      expect(service.listRoles()).toEqual([ModelRole.Chat, ModelRole.Vision, ModelRole.Evaluate]);
    });

    it('should return empty when no roles are configured', () => {
      env = {};

      expect(service.listRoles()).toEqual([]);
    });
  });

  describe('listRoleDetails', () => {
    it('should expose configured models with parsed fallbacks', () => {
      env.AGENT_VISION_MODEL = 'google/gemini-2.0-flash';
      env.AGENT_DEFAULT_FALLBACKS = 'openai/gpt-4o-mini';

      expect(service.listRoleDetails()).toEqual({
        chat: {
          model: 'anthropic/claude-sonnet-4-6',
          fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
        },
        vision: {
          model: 'google/gemini-2.0-flash',
          fallbacks: ['openai/gpt-4o-mini'],
        },
      });
    });
  });

  describe('getFallbacks', () => {
    it('should prefer role-specific fallbacks over defaults', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen-max-latest';

      expect(service.getFallbacks(ModelRole.Chat)).toEqual([
        'openai/gpt-4o',
        'deepseek/deepseek-v4-flash',
      ]);
    });

    it('should fall back to default fallbacks when role-specific fallbacks are missing', () => {
      env.AGENT_EXTRACT_MODEL = 'openai/gpt-4o-mini';
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen-max-latest, google/gemini-2.5-flash';

      expect(service.getFallbacks(ModelRole.Extract)).toEqual([
        'qwen/qwen-max-latest',
        'google/gemini-2.5-flash',
      ]);
    });

    it('should return undefined when no fallbacks are configured', () => {
      expect(service.getFallbacks(ModelRole.Vision)).toBeUndefined();
    });
  });

  describe('getModelIdByRole', () => {
    it('should return the configured model id', () => {
      expect(service.getModelIdByRole(ModelRole.Chat)).toBe('anthropic/claude-sonnet-4-6');
    });

    it('should return an empty string when the role is not configured', () => {
      expect(service.getModelIdByRole(ModelRole.Vision)).toBe('');
    });
  });

  describe('getRouteByRole', () => {
    it('should return the route for a configured role', () => {
      expect(service.getRouteByRole(ModelRole.Chat)).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should treat role strings case-insensitively', () => {
      expect(service.getRouteByRole('CHAT')).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should throw when the role is not configured', () => {
      expect(() => service.getRouteByRole('extract')).toThrow(
        '角色 "extract" 未配置模型 (AGENT_EXTRACT_MODEL)',
      );
    });

    it('should promote the default fallback chain when the role primary model is missing', () => {
      env.AGENT_DEFAULT_FALLBACKS =
        'moonshotai/kimi-k2.6, anthropic/claude-sonnet-4-6, deepseek/deepseek-v4-flash';

      expect(service.getRouteByRole(ModelRole.Repair)).toEqual({
        modelId: 'moonshotai/kimi-k2.6',
        fallbacks: ['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should promote role-specific fallbacks before default fallbacks when primary is missing', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'moonshotai/kimi-k2.6';
      env.AGENT_REPAIR_FALLBACKS = 'anthropic/claude-sonnet-4-6, deepseek/deepseek-v4-flash';

      expect(service.getRouteByRole(ModelRole.Repair)).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['deepseek/deepseek-v4-flash'],
      });
    });
  });

  describe('resolveRoute', () => {
    it('should resolve the configured route when no override is provided', () => {
      expect(service.resolveRoute({ role: ModelRole.Chat })).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should use explicit fallbacks over configured ones', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          fallbacks: ['google/gemini-2.5-flash'],
        }),
      ).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['google/gemini-2.5-flash'],
      });
    });

    it('should trim override model ids and keep fallbacks by default', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          overrideModelId: ' openai/gpt-4o-mini ',
        }),
      ).toEqual({
        modelId: 'openai/gpt-4o-mini',
        fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should disable fallbacks when requested', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          overrideModelId: 'openai/gpt-4o-mini',
          disableFallbacks: true,
        }),
      ).toEqual({
        modelId: 'openai/gpt-4o-mini',
        fallbacks: undefined,
      });
    });

    it('should resolve an unconfigured role through the default fallback chain', () => {
      env.AGENT_DEFAULT_FALLBACKS =
        'moonshotai/kimi-k2.6, anthropic/claude-sonnet-4-6, deepseek/deepseek-v4-flash';

      expect(service.resolveRoute({ role: ModelRole.Repair })).toEqual({
        modelId: 'moonshotai/kimi-k2.6',
        fallbacks: ['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should keep explicit fallbacks when resolving an unconfigured role', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Repair,
          fallbacks: ['anthropic/claude-sonnet-4-6', 'deepseek/deepseek-v4-flash'],
        }),
      ).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['deepseek/deepseek-v4-flash'],
      });
    });
  });

  describe('resolveForTurn', () => {
    it('should default to the chat route', () => {
      expect(service.resolveForTurn({})).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['openai/gpt-4o', 'deepseek/deepseek-v4-flash'],
      });
    });

    it('should honor explicit fallbacks for a chat turn', () => {
      expect(
        service.resolveForTurn({
          fallbacks: ['google/gemini-2.5-flash'],
        }),
      ).toEqual({
        modelId: 'anthropic/claude-sonnet-4-6',
        fallbacks: ['google/gemini-2.5-flash'],
      });
    });
  });
});
