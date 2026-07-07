import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { SystemConfigRepository } from '@biz/hosting-config/repositories/system-config.repository';
import { DEFAULT_AGENT_REPLY_CONFIG } from '@biz/hosting-config/types/hosting-config.types';
import { RedisService } from '@infra/redis/redis.service';

describe('SystemConfigService', () => {
  let service: SystemConfigService;

  const mockSystemConfigRepository = {
    getConfigValue: jest.fn(),
    setConfigValue: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn((key: string, defaultValue?: string) => {
      const config: Record<string, string> = {
        ENABLE_AI_REPLY: 'true',
        ENABLE_MESSAGE_MERGE: 'true',
      };
      return config[key] ?? defaultValue;
    }),
  };

  const mockRedisService = {
    get: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: SystemConfigRepository, useValue: mockSystemConfigRepository },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: RedisService, useValue: mockRedisService },
      ],
    }).compile();

    service = module.get<SystemConfigService>(SystemConfigService);

    jest.clearAllMocks();

    // Reset memory cache state
    (service as any).aiReplyEnabled = null;
    (service as any).aiReplyEnabledExpiry = 0;
    (service as any).messageMergeEnabled = null;
    (service as any).messageMergeEnabledExpiry = 0;
    (service as any).agentReplyConfig = null;
    (service as any).agentReplyConfigExpiry = 0;
    (service as any).configChangeCallbacks = [];
    mockRedisService.get.mockResolvedValue(null);
    mockRedisService.set.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getAiReplyEnabled ====================

  describe('getAiReplyEnabled', () => {
    it('should return memory cached value when available', async () => {
      (service as any).aiReplyEnabled = true;
      (service as any).aiReplyEnabledExpiry = Date.now() + 1000;

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true);
      expect(mockSystemConfigRepository.getConfigValue).not.toHaveBeenCalled();
    });

    it('should load from DB when memory cache is null', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(true);

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true);
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith('ai_reply_enabled');
    });

    it('should initialize default value and write to DB when DB returns null', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true); // from ENABLE_AI_REPLY='true' default
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'ai_reply_enabled',
        true,
        'AI 自动回复功能开关',
      );
    });

    it('should return default value from env when DB load fails', async () => {
      mockSystemConfigRepository.getConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true); // default from env ENABLE_AI_REPLY='true'
    });
  });

  // ==================== setAiReplyEnabled ====================

  describe('setAiReplyEnabled', () => {
    it('should update memory cache and persist to DB', async () => {
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAiReplyEnabled(false);

      expect(result).toBe(false);
      expect((service as any).aiReplyEnabled).toBe(false);
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'ai_reply_enabled',
        false,
      );
    });

    it('should handle DB update failure gracefully', async () => {
      mockSystemConfigRepository.setConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.setAiReplyEnabled(true);

      // Should still return the value and update memory cache
      expect(result).toBe(true);
      expect((service as any).aiReplyEnabled).toBe(true);
    });
  });

  // ==================== getMessageMergeEnabled ====================

  describe('getMessageMergeEnabled', () => {
    it('should return memory cached value when available', async () => {
      (service as any).messageMergeEnabled = false;
      (service as any).messageMergeEnabledExpiry = Date.now() + 1000;

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(false);
      expect(mockSystemConfigRepository.getConfigValue).not.toHaveBeenCalled();
    });

    it('should load from DB when memory cache is null', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(false);

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(false);
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith(
        'message_merge_enabled',
      );
    });

    it('should use env default when DB returns null', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(true); // from ENABLE_MESSAGE_MERGE='true'
    });
  });

  // ==================== setMessageMergeEnabled ====================

  describe('setMessageMergeEnabled', () => {
    it('should update memory cache and persist to DB', async () => {
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setMessageMergeEnabled(false);

      expect(result).toBe(false);
      expect((service as any).messageMergeEnabled).toBe(false);
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'message_merge_enabled',
        false,
      );
    });
  });

  // ==================== getExtractModelOverride ====================

  describe('getExtractModelOverride', () => {
    it('returns trimmed model id when configured', async () => {
      (service as any).agentReplyConfig = {
        ...DEFAULT_AGENT_REPLY_CONFIG,
        extractModelId: '  deepseek/deepseek-v4-flash  ',
      };
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;

      await expect(service.getExtractModelOverride()).resolves.toBe('deepseek/deepseek-v4-flash');
    });

    it('returns undefined when not configured (falls back to role routing)', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, extractModelId: '' };
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;

      await expect(service.getExtractModelOverride()).resolves.toBeUndefined();
    });

    it('normalizes non-string extractModelId from legacy DB rows to default', async () => {
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        extractModelId: 123,
      });

      const result = await service.getAgentReplyConfig();

      expect(result.extractModelId).toBe('');
    });
  });

  // ==================== getAgentReplyConfig ====================

  describe('getAgentReplyConfig', () => {
    it('should return memory cached config when cache is valid', async () => {
      const cachedConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, initialMergeWindowMs: 5000 };
      (service as any).agentReplyConfig = cachedConfig;
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;

      const result = await service.getAgentReplyConfig();

      expect(result).toEqual(cachedConfig);
      expect(mockSystemConfigRepository.getConfigValue).not.toHaveBeenCalled();
    });

    it('should reload from DB when memory cache is expired', async () => {
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith('agent_reply_config');
    });

    it('should seed default config when DB returns null', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'agent_reply_config',
        DEFAULT_AGENT_REPLY_CONFIG,
        'Agent 运行时配置（模型、消息聚合、打字延迟、告警节流）',
      );
    });

    it('should return default config and set short backoff when DB fails', async () => {
      mockSystemConfigRepository.getConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
      // Backoff expiry should be ~30 seconds
      const expiry = (service as any).agentReplyConfigExpiry;
      expect(expiry).toBeGreaterThan(Date.now());
    });
  });

  // ==================== setAgentReplyConfig ====================

  describe('setAgentReplyConfig', () => {
    it('should merge partial config with existing config', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const partial = { initialMergeWindowMs: 10_000 };
      const result = await service.setAgentReplyConfig(partial);

      expect(result.initialMergeWindowMs).toBe(10_000);
      // Other fields should remain from DEFAULT
      expect(result.paragraphGapMs).toBe(DEFAULT_AGENT_REPLY_CONFIG.paragraphGapMs);
    });

    it('should use DEFAULT_AGENT_REPLY_CONFIG as base when no existing config', async () => {
      (service as any).agentReplyConfig = null;
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const partial = { initialMergeWindowMs: 7000 };
      const result = await service.setAgentReplyConfig(partial);

      expect(result.initialMergeWindowMs).toBe(7000);
      expect(result.paragraphGapMs).toBe(DEFAULT_AGENT_REPLY_CONFIG.paragraphGapMs);
    });

    it('should persist to DB', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      await service.setAgentReplyConfig({ initialMergeWindowMs: 5000 });

      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'agent_reply_config',
        expect.objectContaining({ initialMergeWindowMs: 5000 }),
        'Agent 运行时配置（模型、消息聚合、打字延迟、告警节流）',
      );
    });

    it('should notify registered callbacks on config change', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const callback = jest.fn();
      service.onAgentReplyConfigChange(callback);

      await service.setAgentReplyConfig({ initialMergeWindowMs: 5000 });

      expect(callback).toHaveBeenCalledWith(
        expect.objectContaining({ initialMergeWindowMs: 5000 }),
      );
    });

    it('should handle callback errors gracefully', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const errorCallback = jest.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      service.onAgentReplyConfigChange(errorCallback);

      await expect(service.setAgentReplyConfig({})).resolves.not.toThrow();
    });

    it('force-reloads the merge baseline from source (loader) instead of the in-memory cache', async () => {
      // 内存缓存是"旧"配置（模拟重启后/多实例落后的本地基线），且仍在有效期内
      (service as any).agentReplyConfig = {
        ...DEFAULT_AGENT_REPLY_CONFIG,
        paragraphGapMs: 1111,
      };
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;
      // 回源链路：Redis 共享缓存 miss → DB 里是别的实例写入的最新配置
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        paragraphGapMs: 9999,
        reengagementScenarioRollout: { sceneA: true },
      });
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAgentReplyConfig({ initialMergeWindowMs: 4321 });

      // 保存路径必须回源（读了 agent_reply_config），而不是拿内存缓存当基线
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith('agent_reply_config');
      // 基线字段来自 DB（9999），而不是过期风险的内存值（1111）
      expect(result.paragraphGapMs).toBe(9999);
      expect(result.initialMergeWindowMs).toBe(4321);
      // DB 里已有的场景灰度不能被这次不相关的保存冲掉
      expect(result.reengagementScenarioRollout).toEqual({ sceneA: true });
    });

    it('merges reengagementScenarioRollout per-key: partial {sceneB} preserves existing sceneA', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        reengagementScenarioRollout: { sceneA: true },
      });
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAgentReplyConfig({
        reengagementScenarioRollout: { sceneB: true },
      });

      expect(result.reengagementScenarioRollout).toEqual({ sceneA: true, sceneB: true });
      // 持久化的也是合并后的完整 map，不是调用方传的增量
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'agent_reply_config',
        expect.objectContaining({
          reengagementScenarioRollout: { sceneA: true, sceneB: true },
        }),
        expect.any(String),
      );
    });

    it('allows a partial rollout update to flip an existing scenario off without touching others', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        reengagementScenarioRollout: { sceneA: true, sceneB: true },
      });
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAgentReplyConfig({
        reengagementScenarioRollout: { sceneA: false },
      });

      expect(result.reengagementScenarioRollout).toEqual({ sceneA: false, sceneB: true });
    });
  });

  // ==================== sanitizeScenarioRollout（经 normalize 生效） ====================

  describe('reengagementScenarioRollout sanitization', () => {
    it('drops non-boolean values from DB rows (truthy strings must not become true)', async () => {
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        reengagementScenarioRollout: {
          dirtyString: 'true',
          dirtyNumber: 1,
          dirtyNull: null,
          cleanOn: true,
          cleanOff: false,
        },
      });

      const result = await service.getAgentReplyConfig();

      expect(result.reengagementScenarioRollout).toEqual({ cleanOn: true, cleanOff: false });
    });

    it('normalizes a non-object rollout (array/string/missing) to an empty map', async () => {
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        reengagementScenarioRollout: ['sceneA'],
      });

      const result = await service.getAgentReplyConfig();

      expect(result.reengagementScenarioRollout).toEqual({});
    });

    it('strips dirty values from the caller-provided rollout on save', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue({
        ...DEFAULT_AGENT_REPLY_CONFIG,
        reengagementScenarioRollout: { sceneA: true },
      });
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAgentReplyConfig({
        reengagementScenarioRollout: { dirty: 'yes', sceneB: true } as never,
      });

      expect(result.reengagementScenarioRollout).toEqual({ sceneA: true, sceneB: true });
      expect(result.reengagementScenarioRollout).not.toHaveProperty('dirty');
    });
  });

  // ==================== onAgentReplyConfigChange ====================

  describe('onAgentReplyConfigChange', () => {
    it('should register and invoke multiple callbacks', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const cb1 = jest.fn();
      const cb2 = jest.fn();
      service.onAgentReplyConfigChange(cb1);
      service.onAgentReplyConfigChange(cb2);

      await service.setAgentReplyConfig({});

      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(1);
    });
  });

  // ==================== getSystemConfig ====================

  describe('getSystemConfig', () => {
    it('should load system config from DB', async () => {
      const mockConfig = { workerConcurrency: 3 };
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(mockConfig);

      const result = await service.getSystemConfig();

      expect(result).toEqual(mockConfig);
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith('system_config');
    });

    it('should return null when no config in DB', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);

      const result = await service.getSystemConfig();

      expect(result).toBeNull();
    });

    it('should return null when DB throws error', async () => {
      mockSystemConfigRepository.getConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.getSystemConfig();

      expect(result).toBeNull();
    });
  });

  // ==================== updateSystemConfig ====================

  describe('updateSystemConfig', () => {
    it('should merge new config with existing config', async () => {
      const existingConfig = { workerConcurrency: 3 };
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(existingConfig);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.updateSystemConfig({ workerConcurrency: 10 });

      expect(result.workerConcurrency).toBe(10);
    });

    it('should create config from scratch when no existing config', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.updateSystemConfig({ workerConcurrency: 5 });

      expect(result.workerConcurrency).toBe(5);
    });

    it('should persist to DB', async () => {
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      await service.updateSystemConfig({ workerConcurrency: 5 });

      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'system_config',
        expect.objectContaining({ workerConcurrency: 5 }),
        '系统配置（Worker 并发数等）',
      );
    });
  });

  // ==================== refreshCache ====================

  describe('refreshCache', () => {
    it('should clear all memory caches and reload from DB', async () => {
      (service as any).aiReplyEnabled = true;
      (service as any).messageMergeEnabled = true;
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;

      // Mock the reload calls
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(true);

      await service.refreshCache();

      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalled();
    });

    it('should set aiReplyEnabled to null before reloading', async () => {
      (service as any).aiReplyEnabled = true;
      (service as any).messageMergeEnabled = false;
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;

      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      await service.refreshCache();

      // After refresh, aiReplyEnabled should be loaded from DB (not null)
      expect((service as any).aiReplyEnabled).not.toBeNull();
    });
  });
});
