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
      AGENT_CHAT_MODEL: 'qwen/qwen4-max',
      AGENT_CHAT_FALLBACKS: 'qwen/qwen3.7-plus, deepseek/deepseek-flash',
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
      env.AGENT_VISION_MODEL = 'qwen/qwen3-vl-plus';
      env.AGENT_EVALUATE_MODEL = 'qwen/qwen3.7-flash';

      expect(service.listRoles()).toEqual([ModelRole.Chat, ModelRole.Vision, ModelRole.Evaluate]);
    });

    it('should return empty when no roles are configured', () => {
      env = {};

      expect(service.listRoles()).toEqual([]);
    });
  });

  describe('listRoleDetails', () => {
    it('should expose configured models with parsed fallbacks', () => {
      env.AGENT_VISION_MODEL = 'qwen/qwen3-vl-plus';
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen3.7-flash';

      expect(service.listRoleDetails()).toEqual({
        chat: {
          model: 'qwen/qwen4-max',
          fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
        },
        vision: {
          model: 'qwen/qwen3-vl-plus',
          fallbacks: ['qwen/qwen3.7-flash'],
        },
      });
    });
  });

  describe('getFallbacks', () => {
    it('should prefer role-specific fallbacks over defaults', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen-max-latest';

      expect(service.getFallbacks(ModelRole.Chat)).toEqual([
        'qwen/qwen3.7-plus',
        'deepseek/deepseek-flash',
      ]);
    });

    it('should fall back to default fallbacks when role-specific fallbacks are missing', () => {
      env.AGENT_EXTRACT_MODEL = 'qwen/qwen3.7-flash';
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen-max-latest, deepseek/deepseek-v4-pro';

      expect(service.getFallbacks(ModelRole.Extract)).toEqual([
        'qwen/qwen-max-latest',
        'deepseek/deepseek-v4-pro',
      ]);
    });

    it('should return undefined when no fallbacks are configured', () => {
      expect(service.getFallbacks(ModelRole.Vision)).toBeUndefined();
    });
  });

  describe('getModelIdByRole', () => {
    it('should return the configured model id', () => {
      expect(service.getModelIdByRole(ModelRole.Chat)).toBe('qwen/qwen4-max');
    });

    it('should return an empty string when the role is not configured', () => {
      expect(service.getModelIdByRole(ModelRole.Vision)).toBe('');
    });
  });

  describe('getRouteByRole', () => {
    it('should return the route for a configured role', () => {
      expect(service.getRouteByRole(ModelRole.Chat)).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
      });
    });

    it('should treat role strings case-insensitively', () => {
      expect(service.getRouteByRole('CHAT')).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
      });
    });

    it('should throw when the role is not configured', () => {
      expect(() => service.getRouteByRole('extract')).toThrow(
        '角色 "extract" 未配置模型 (AGENT_EXTRACT_MODEL)',
      );
    });

    it('should promote the default fallback chain when the role primary model is missing', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen3.8-max, qwen/qwen4-max, deepseek/deepseek-flash';

      expect(service.getRouteByRole(ModelRole.Repair)).toEqual({
        modelId: 'qwen/qwen3.8-max',
        fallbacks: ['qwen/qwen4-max', 'deepseek/deepseek-flash'],
      });
    });

    it('should promote role-specific fallbacks before default fallbacks when primary is missing', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen3.8-max';
      env.AGENT_REPAIR_FALLBACKS = 'qwen/qwen4-max, deepseek/deepseek-flash';

      expect(service.getRouteByRole(ModelRole.Repair)).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['deepseek/deepseek-flash'],
      });
    });
  });

  describe('resolveRoute', () => {
    it('should resolve the configured route when no override is provided', () => {
      expect(service.resolveRoute({ role: ModelRole.Chat })).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
      });
    });

    it('should use explicit fallbacks over configured ones', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          fallbacks: ['deepseek/deepseek-v4-pro'],
        }),
      ).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['deepseek/deepseek-v4-pro'],
      });
    });

    it('should trim override model ids and keep fallbacks by default', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          overrideModelId: ' qwen/qwen3.7-flash ',
        }),
      ).toEqual({
        modelId: 'qwen/qwen3.7-flash',
        fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
      });
    });

    it('rejects retired manual overrides and migrates persisted fallback settings', () => {
      env.AGENT_CHAT_FALLBACKS = 'anthropic/claude-sonnet-5,deepseek/deepseek-v4-flash';
      expect(service.getRouteByRole('chat').fallbacks).toEqual(['deepseek/deepseek-flash']);
      expect(() => service.resolveRoute({ overrideModelId: 'moonshotai/kimi-k3' })).toThrow(
        '不支持',
      );
      expect(() => service.resolveRoute({ fallbacks: ['openrouter/qwen/qwen4-max'] })).toThrow(
        '不支持',
      );
    });

    it('should disable fallbacks when requested', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Chat,
          overrideModelId: 'qwen/qwen3.7-flash',
          disableFallbacks: true,
        }),
      ).toEqual({
        modelId: 'qwen/qwen3.7-flash',
        fallbacks: undefined,
      });
    });

    it('should resolve an unconfigured role through the default fallback chain', () => {
      env.AGENT_DEFAULT_FALLBACKS = 'qwen/qwen3.8-max, qwen/qwen4-max, deepseek/deepseek-flash';

      expect(service.resolveRoute({ role: ModelRole.Repair })).toEqual({
        modelId: 'qwen/qwen3.8-max',
        fallbacks: ['qwen/qwen4-max', 'deepseek/deepseek-flash'],
      });
    });

    it('should keep explicit fallbacks when resolving an unconfigured role', () => {
      expect(
        service.resolveRoute({
          role: ModelRole.Repair,
          fallbacks: ['qwen/qwen4-max', 'deepseek/deepseek-flash'],
        }),
      ).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['deepseek/deepseek-flash'],
      });
    });
  });

  describe('resolveForTurn', () => {
    it('should default to the chat route', () => {
      expect(service.resolveForTurn({})).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['qwen/qwen3.7-plus', 'deepseek/deepseek-flash'],
      });
    });

    it('should honor explicit fallbacks for a chat turn', () => {
      expect(
        service.resolveForTurn({
          fallbacks: ['deepseek/deepseek-v4-pro'],
        }),
      ).toEqual({
        modelId: 'qwen/qwen4-max',
        fallbacks: ['deepseek/deepseek-v4-pro'],
      });
    });
  });
});
