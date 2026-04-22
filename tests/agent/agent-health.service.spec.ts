import { Test, TestingModule } from '@nestjs/testing';
import { AgentHealthService } from '@agent/agent-health.service';
import { RedisService } from '@infra/redis/redis.service';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { RegistryService } from '@providers/registry.service';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { ContextService } from '@agent/context/context.service';

describe('AgentHealthService', () => {
  let service: AgentHealthService;

  const mockRedisService = {
    ping: jest.fn().mockResolvedValue('PONG'),
  };

  const mockSupabaseService = {
    isAvailable: jest.fn().mockReturnValue(true),
    getSupabaseClient: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    }),
  };

  const mockToolRegistry = {
    listBySource: jest
      .fn()
      .mockImplementation((source: string) =>
        source === 'built-in' ? ['advance_stage', 'recall_history'] : ['mcp_tool_1'],
      ),
  };

  const mockRegistry = {
    listProviders: jest.fn().mockReturnValue(['anthropic']),
  };

  const mockRouter = {
    listRoleDetails: jest.fn().mockReturnValue({
      chat: { model: 'anthropic/claude-sonnet-4-6' },
    }),
  };

  const mockContext = {
    getLoadedScenarios: jest.fn().mockReturnValue(['candidate-consultation']),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentHealthService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: SupabaseService, useValue: mockSupabaseService },
        { provide: ToolRegistryService, useValue: mockToolRegistry },
        { provide: RegistryService, useValue: mockRegistry },
        { provide: RouterService, useValue: mockRouter },
        { provide: ContextService, useValue: mockContext },
      ],
    }).compile();

    service = module.get<AgentHealthService>(AgentHealthService);
    jest.clearAllMocks();

    // Restore default happy-path mocks
    mockRedisService.ping.mockResolvedValue('PONG');
    mockSupabaseService.isAvailable.mockReturnValue(true);
    mockSupabaseService.getSupabaseClient.mockReturnValue({
      from: jest.fn().mockReturnValue({
        select: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue({ error: null }),
        }),
      }),
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('check', () => {
    it('should return healthy when all dependencies are available', async () => {
      const result = await service.check();

      expect(result.status).toBe('healthy');
      expect(result.message).toBe('Agent 服务正常');
      expect(result.checks).toEqual({ redis: true, supabase: true });
      expect(result.providers).toEqual(['anthropic']);
      expect(result.tools.builtIn).toEqual(['advance_stage', 'recall_history']);
      expect(result.tools.mcp).toEqual(['mcp_tool_1']);
      expect(result.tools.total).toBe(3);
    });

    it('should return unhealthy when Redis is down', async () => {
      mockRedisService.ping.mockRejectedValue(new Error('Connection refused'));

      const result = await service.check();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('Redis 不可用');
      expect(result.checks.redis).toBe(false);
      expect(result.checks.supabase).toBe(true);
    });

    it('should return unhealthy when Redis returns non-PONG', async () => {
      mockRedisService.ping.mockResolvedValue('ERROR');

      const result = await service.check();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.redis).toBe(false);
    });

    it('should return degraded when Supabase is unavailable', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      const result = await service.check();

      expect(result.status).toBe('degraded');
      expect(result.message).toContain('Supabase 不可用');
      expect(result.checks.redis).toBe(true);
      expect(result.checks.supabase).toBe(false);
    });

    it('should return degraded when Supabase client is null', async () => {
      mockSupabaseService.getSupabaseClient.mockReturnValue(null);

      const result = await service.check();

      expect(result.status).toBe('degraded');
      expect(result.checks.supabase).toBe(false);
    });

    it('should return degraded when Supabase query fails', async () => {
      mockSupabaseService.getSupabaseClient.mockReturnValue({
        from: jest.fn().mockReturnValue({
          select: jest.fn().mockReturnValue({
            limit: jest.fn().mockResolvedValue({ error: { message: 'relation not found' } }),
          }),
        }),
      });

      const result = await service.check();

      expect(result.status).toBe('degraded');
      expect(result.checks.supabase).toBe(false);
    });

    it('should return unhealthy when both Redis and Supabase fail (Redis takes priority)', async () => {
      mockRedisService.ping.mockRejectedValue(new Error('Redis down'));
      mockSupabaseService.isAvailable.mockReturnValue(false);

      const result = await service.check();

      expect(result.status).toBe('unhealthy');
      expect(result.message).toContain('Redis');
      expect(result.checks).toEqual({ redis: false, supabase: false });
    });

    it('should handle Supabase throwing an exception', async () => {
      mockSupabaseService.getSupabaseClient.mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      const result = await service.check();

      expect(result.status).toBe('degraded');
      expect(result.checks.supabase).toBe(false);
    });
  });
});
