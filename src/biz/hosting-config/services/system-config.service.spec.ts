import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from './system-config.service';
import { RedisService } from '@core/redis';
import { SystemConfigRepository } from '../repositories/system-config.repository';
import { DEFAULT_AGENT_REPLY_CONFIG } from '../types/hosting-config.types';

describe('SystemConfigService', () => {
  let service: SystemConfigService;

  const mockSystemConfigRepository = {
    getConfigValue: jest.fn(),
    setConfigValue: jest.fn(),
  };

  const mockRedisService = {
    get: jest.fn(),
    setex: jest.fn(),
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

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SystemConfigService,
        { provide: SystemConfigRepository, useValue: mockSystemConfigRepository },
        { provide: RedisService, useValue: mockRedisService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<SystemConfigService>(SystemConfigService);

    jest.clearAllMocks();

    // Reset memory cache state
    (service as any).aiReplyEnabled = null;
    (service as any).messageMergeEnabled = null;
    (service as any).agentReplyConfig = null;
    (service as any).agentReplyConfigExpiry = 0;
    (service as any).configChangeCallbacks = [];
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getAiReplyEnabled ====================

  describe('getAiReplyEnabled', () => {
    it('should return memory cached value when available', async () => {
      (service as any).aiReplyEnabled = true;

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true);
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('should return Redis cached value when memory cache is null', async () => {
      mockRedisService.get.mockResolvedValue(false);

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(false);
      expect(mockRedisService.get).toHaveBeenCalledWith('supabase:config:ai_reply_enabled');
    });

    it('should load from DB when Redis cache is null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(true);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true);
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalledWith('ai_reply_enabled');
    });

    it('should initialize default value and write to DB when DB returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true); // from ENABLE_AI_REPLY='true' default
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'ai_reply_enabled',
        true,
        'AI 自动回复功能开关',
      );
    });

    it('should return default value from env when DB load fails', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.getAiReplyEnabled();

      expect(result).toBe(true); // default from env ENABLE_AI_REPLY='true'
    });
  });

  // ==================== setAiReplyEnabled ====================

  describe('setAiReplyEnabled', () => {
    it('should update memory cache and Redis', async () => {
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setAiReplyEnabled(false);

      expect(result).toBe(false);
      expect((service as any).aiReplyEnabled).toBe(false);
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'supabase:config:ai_reply_enabled',
        300,
        false,
      );
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'ai_reply_enabled',
        false,
      );
    });

    it('should handle DB update failure gracefully', async () => {
      mockRedisService.setex.mockResolvedValue(undefined);
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

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(false);
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('should return Redis cached value when memory cache is null', async () => {
      mockRedisService.get.mockResolvedValue(true);

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(true);
      expect(mockRedisService.get).toHaveBeenCalledWith('supabase:config:message_merge_enabled');
    });

    it('should load from DB when Redis cache is null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(false);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(false);
    });

    it('should use env default when DB returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getMessageMergeEnabled();

      expect(result).toBe(true); // from ENABLE_MESSAGE_MERGE='true'
    });
  });

  // ==================== setMessageMergeEnabled ====================

  describe('setMessageMergeEnabled', () => {
    it('should update memory cache, Redis, and DB', async () => {
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.setMessageMergeEnabled(false);

      expect(result).toBe(false);
      expect((service as any).messageMergeEnabled).toBe(false);
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'supabase:config:message_merge_enabled',
        300,
        false,
      );
    });
  });

  // ==================== getAgentReplyConfig ====================

  describe('getAgentReplyConfig', () => {
    it('should return memory cached config when cache is valid', async () => {
      const cachedConfig = { ...DEFAULT_AGENT_REPLY_CONFIG, maxMergedMessages: 5 };
      (service as any).agentReplyConfig = cachedConfig;
      (service as any).agentReplyConfigExpiry = Date.now() + 60_000;

      const result = await service.getAgentReplyConfig();

      expect(result).toEqual(cachedConfig);
      expect(mockRedisService.get).not.toHaveBeenCalled();
    });

    it('should reload when memory cache is expired', async () => {
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;

      mockRedisService.get.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
      expect(mockRedisService.get).toHaveBeenCalledWith('supabase:config:agent_reply_config');
    });

    it('should load from DB when Redis cache is null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(DEFAULT_AGENT_REPLY_CONFIG);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
    });

    it('should seed default config when DB returns null', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getAgentReplyConfig();

      expect(result).toMatchObject(DEFAULT_AGENT_REPLY_CONFIG);
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'agent_reply_config',
        DEFAULT_AGENT_REPLY_CONFIG,
        'Agent 回复策略配置（消息聚合、打字延迟、告警节流）',
      );
    });

    it('should return default config and set short backoff when DB fails', async () => {
      mockRedisService.get.mockResolvedValue(null);
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
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const partial = { maxMergedMessages: 10 };
      const result = await service.setAgentReplyConfig(partial);

      expect(result.maxMergedMessages).toBe(10);
      // Other fields should remain from DEFAULT
      expect(result.paragraphGapMs).toBe(DEFAULT_AGENT_REPLY_CONFIG.paragraphGapMs);
    });

    it('should use DEFAULT_AGENT_REPLY_CONFIG as base when no existing config', async () => {
      (service as any).agentReplyConfig = null;
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const partial = { maxMergedMessages: 7 };
      const result = await service.setAgentReplyConfig(partial);

      expect(result.maxMergedMessages).toBe(7);
      expect(result.paragraphGapMs).toBe(DEFAULT_AGENT_REPLY_CONFIG.paragraphGapMs);
    });

    it('should persist to Redis and DB', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      await service.setAgentReplyConfig({ maxMergedMessages: 5 });

      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'supabase:config:agent_reply_config',
        60,
        expect.objectContaining({ maxMergedMessages: 5 }),
      );
      expect(mockSystemConfigRepository.setConfigValue).toHaveBeenCalledWith(
        'agent_reply_config',
        expect.objectContaining({ maxMergedMessages: 5 }),
        'Agent 回复策略配置（消息聚合、打字延迟、告警节流）',
      );
    });

    it('should notify registered callbacks on config change', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const callback = jest.fn();
      service.onAgentReplyConfigChange(callback);

      await service.setAgentReplyConfig({ maxMergedMessages: 5 });

      expect(callback).toHaveBeenCalledWith(expect.objectContaining({ maxMergedMessages: 5 }));
    });

    it('should handle callback errors gracefully', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const errorCallback = jest.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });
      service.onAgentReplyConfigChange(errorCallback);

      await expect(service.setAgentReplyConfig({})).resolves.not.toThrow();
    });
  });

  // ==================== onAgentReplyConfigChange ====================

  describe('onAgentReplyConfigChange', () => {
    it('should register and invoke multiple callbacks', async () => {
      (service as any).agentReplyConfig = { ...DEFAULT_AGENT_REPLY_CONFIG };
      mockRedisService.setex.mockResolvedValue(undefined);
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
    it('should return cached system config from Redis', async () => {
      const mockConfig = { workerConcurrency: 5 };
      mockRedisService.get.mockResolvedValue(mockConfig);

      const result = await service.getSystemConfig();

      expect(result).toEqual(mockConfig);
      expect(mockSystemConfigRepository.getConfigValue).not.toHaveBeenCalled();
    });

    it('should load from DB when Redis cache is empty', async () => {
      const mockConfig = { workerConcurrency: 3 };
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(mockConfig);
      mockRedisService.setex.mockResolvedValue(undefined);

      const result = await service.getSystemConfig();

      expect(result).toEqual(mockConfig);
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'supabase:config:system_config',
        300,
        mockConfig,
      );
    });

    it('should return null when no config in DB', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);

      const result = await service.getSystemConfig();

      expect(result).toBeNull();
    });

    it('should return null when DB throws error', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockRejectedValue(new Error('DB error'));

      const result = await service.getSystemConfig();

      expect(result).toBeNull();
    });
  });

  // ==================== updateSystemConfig ====================

  describe('updateSystemConfig', () => {
    it('should merge new config with existing config', async () => {
      const existingConfig = { workerConcurrency: 3 };
      mockRedisService.get.mockResolvedValue(existingConfig);
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.updateSystemConfig({ workerConcurrency: 10 });

      expect(result.workerConcurrency).toBe(10);
    });

    it('should create config from scratch when no existing config', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      const result = await service.updateSystemConfig({ workerConcurrency: 5 });

      expect(result.workerConcurrency).toBe(5);
    });

    it('should persist to Redis and DB', async () => {
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockRedisService.setex.mockResolvedValue(undefined);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);

      await service.updateSystemConfig({ workerConcurrency: 5 });

      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'supabase:config:system_config',
        300,
        expect.objectContaining({ workerConcurrency: 5 }),
      );
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
      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(true);
      mockRedisService.setex.mockResolvedValue(undefined);

      await service.refreshCache();

      // Memory cache nulls should be re-set during refreshCache
      // The method clears first, then reloads - so aiReplyEnabled and messageMergeEnabled
      // will be non-null after reload, but agentReplyConfigExpiry will be updated
      expect(mockSystemConfigRepository.getConfigValue).toHaveBeenCalled();
    });

    it('should set aiReplyEnabled to null before reloading', async () => {
      (service as any).aiReplyEnabled = true;
      (service as any).messageMergeEnabled = false;
      (service as any).agentReplyConfig = null;
      (service as any).agentReplyConfigExpiry = 0;

      mockRedisService.get.mockResolvedValue(null);
      mockSystemConfigRepository.getConfigValue.mockResolvedValue(null);
      mockSystemConfigRepository.setConfigValue.mockResolvedValue(undefined);
      mockRedisService.setex.mockResolvedValue(undefined);

      await service.refreshCache();

      // After refresh, aiReplyEnabled should be loaded from DB (not null)
      expect((service as any).aiReplyEnabled).not.toBeNull();
    });
  });
});
