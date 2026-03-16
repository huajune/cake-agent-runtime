import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentRegistryService } from '@agent/services/agent-registry.service';
import { AgentApiClientService } from '@agent/services/agent-api-client.service';
import { FeishuAlertService } from '@core/feishu';

describe('AgentRegistryService', () => {
  let service: AgentRegistryService;

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockApiClient = {
    getModels: jest.fn(),
    getTools: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(undefined),
    sendSimpleAlert: jest.fn().mockResolvedValue(undefined),
  };

  const defaultModelsResponse = {
    data: {
      models: [
        { id: 'anthropic/claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
        { id: 'anthropic/claude-3-5-haiku', name: 'Claude 3.5 Haiku' },
        { id: 'openai/gpt-4o', name: 'GPT-4o' },
      ],
    },
  };

  const defaultToolsResponse = {
    data: {
      tools: [
        { name: 'job_list', requiresSandbox: false, requiredContext: ['dulidayToken'] },
        { name: 'wework_plan_turn', requiresSandbox: false, requiredContext: ['stageGoals'] },
        { name: 'bash', requiresSandbox: true, requiredContext: [] },
      ],
    },
  };

  function setupConfigMock(overrides?: Record<string, any>) {
    const defaults: Record<string, any> = {
      AGENT_DEFAULT_MODEL: 'anthropic/claude-3-7-sonnet',
      AGENT_CHAT_MODEL: 'anthropic/claude-3-7-sonnet',
      AGENT_CLASSIFY_MODEL: 'anthropic/claude-3-5-haiku',
      AGENT_ALLOWED_TOOLS: 'job_list,wework_plan_turn',
      AGENT_REGISTRY_REFRESH_INTERVAL_MS: 3600000,
      ...overrides,
    };
    mockConfigService.get.mockImplementation((key: string, defaultVal?: any) => {
      return defaults[key] ?? defaultVal;
    });
  }

  beforeEach(async () => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    setupConfigMock();
    mockApiClient.getModels.mockResolvedValue(defaultModelsResponse);
    mockApiClient.getTools.mockResolvedValue(defaultToolsResponse);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRegistryService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentApiClientService, useValue: mockApiClient },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
      ],
    }).compile();

    service = module.get<AgentRegistryService>(AgentRegistryService);
  });

  afterEach(() => {
    jest.useRealTimers();
    service.onModuleDestroy();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should load models and tools on initialization', async () => {
      await service.onModuleInit();

      expect(mockApiClient.getModels).toHaveBeenCalled();
      expect(mockApiClient.getTools).toHaveBeenCalled();
    });

    it('should set isInitialized to true after successful load', async () => {
      await service.onModuleInit();

      expect(service.isInitialized()).toBe(true);
    });

    it('should retry on initialization failure', async () => {
      jest.useRealTimers(); // Use real timers for this test to avoid timer conflicts

      mockApiClient.getModels
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue(defaultModelsResponse);

      await service.onModuleInit();
      service.onModuleDestroy(); // Clean up

      expect(mockApiClient.getModels).toHaveBeenCalledTimes(2);
    }, 15000);

    it('should send feishu alert when all retries fail', async () => {
      jest.useRealTimers(); // Use real timers for this test to avoid timer conflicts

      const networkError = new Error('Persistent network error');
      mockApiClient.getModels.mockRejectedValue(networkError);

      await service.onModuleInit();
      service.onModuleDestroy(); // Clean up

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'agent',
          scenario: 'REGISTRY_INIT_FAILED',
        }),
      );
    }, 15000);

    it('should start auto-refresh timer after init', async () => {
      await service.onModuleInit();
      // The timer should be running - verify by advancing time and checking refresh
      jest.advanceTimersByTime(3600000);
      await Promise.resolve(); // Flush microtasks
      expect(mockApiClient.getModels).toHaveBeenCalledTimes(2); // init + 1 refresh
    });
  });

  describe('onModuleDestroy', () => {
    it('should clear the refresh timer', async () => {
      await service.onModuleInit();
      service.onModuleDestroy();

      // After destroy, timer should not fire
      jest.advanceTimersByTime(7200000);
      await Promise.resolve();
      // getModels called once on init, no additional calls after destroy
      expect(mockApiClient.getModels).toHaveBeenCalledTimes(1);
    });
  });

  describe('refresh', () => {
    it('should update available models from API', async () => {
      await service.refresh();

      const models = service.getAvailableModels();
      expect(models).toContain('anthropic/claude-3-7-sonnet');
      expect(models).toContain('anthropic/claude-3-5-haiku');
      expect(models).toContain('openai/gpt-4o');
    });

    it('should update available tools from API', async () => {
      await service.refresh();

      expect(service.isToolAvailable('job_list')).toBe(true);
      expect(service.isToolAvailable('wework_plan_turn')).toBe(true);
      expect(service.isToolAvailable('bash')).toBe(true);
    });

    it('should handle empty models response', async () => {
      mockApiClient.getModels.mockResolvedValue({ data: { models: [] } });

      await service.refresh();

      expect(service.getAvailableModels()).toEqual([]);
    });

    it('should handle empty tools response', async () => {
      mockApiClient.getTools.mockResolvedValue({ data: { tools: [] } });

      await service.refresh();

      expect(service.getAvailableTools().size).toBe(0);
    });

    it('should throw error when API call fails', async () => {
      mockApiClient.getModels.mockRejectedValue(new Error('API error'));

      await expect(service.refresh()).rejects.toThrow('API error');
    });

    it('should handle null/undefined API response gracefully', async () => {
      mockApiClient.getModels.mockResolvedValue(null);
      mockApiClient.getTools.mockResolvedValue(null);

      await service.refresh();

      expect(service.getAvailableModels()).toEqual([]);
      expect(service.getAvailableTools().size).toBe(0);
    });

    it('should update lastRefreshTime after successful refresh', async () => {
      const beforeRefresh = new Date();
      await service.refresh();

      const health = service.getHealthStatus();
      expect(health.lastRefreshTime).toBeDefined();
      expect(new Date(health.lastRefreshTime!)).toBeInstanceOf(Date);
      expect(new Date(health.lastRefreshTime!) >= beforeRefresh).toBe(true);
    });
  });

  describe('validateModel', () => {
    beforeEach(async () => {
      await service.refresh();
    });

    it('should return configured default model when no model specified', () => {
      const result = service.validateModel();
      expect(result).toBe('anthropic/claude-3-7-sonnet');
    });

    it('should return the requested model when it is available', () => {
      const result = service.validateModel('openai/gpt-4o');
      expect(result).toBe('openai/gpt-4o');
    });

    it('should fall back to default model when requested model is unavailable', () => {
      const result = service.validateModel('non-existent-model');
      expect(result).toBe('anthropic/claude-3-7-sonnet');
    });

    it('should use configured model when available models list is empty', async () => {
      mockApiClient.getModels.mockResolvedValue({ data: { models: [] } });
      await service.refresh();

      const result = service.validateModel('some-model');
      expect(result).toBe('anthropic/claude-3-7-sonnet');
    });

    it('should return configured model when undefined is passed', () => {
      const result = service.validateModel(undefined);
      expect(result).toBe('anthropic/claude-3-7-sonnet');
    });
  });

  describe('validateTools', () => {
    beforeEach(async () => {
      await service.refresh();
    });

    it('should return configured tools when undefined is passed', () => {
      const result = service.validateTools(undefined);
      expect(result).toEqual(['job_list', 'wework_plan_turn']);
    });

    it('should return empty array when empty array is passed', () => {
      const result = service.validateTools([]);
      expect(result).toEqual([]);
    });

    it('should filter out unavailable tools', () => {
      const result = service.validateTools(['job_list', 'non-existent-tool', 'bash']);
      expect(result).toContain('job_list');
      expect(result).toContain('bash');
      expect(result).not.toContain('non-existent-tool');
    });

    it('should return all requested tools when tools list is not initialized', async () => {
      mockApiClient.getTools.mockResolvedValue({ data: { tools: [] } });
      await service.refresh();

      const result = service.validateTools(['some-tool', 'another-tool']);
      expect(result).toEqual(['some-tool', 'another-tool']);
    });

    it('should return only available tools from the requested list', () => {
      const result = service.validateTools(['job_list', 'wework_plan_turn']);
      expect(result).toEqual(['job_list', 'wework_plan_turn']);
    });
  });

  describe('isToolAvailable', () => {
    beforeEach(async () => {
      await service.refresh();
    });

    it('should return true for an available tool', () => {
      expect(service.isToolAvailable('job_list')).toBe(true);
    });

    it('should return false for an unavailable tool', () => {
      expect(service.isToolAvailable('non-existent-tool')).toBe(false);
    });
  });

  describe('getToolInfo', () => {
    beforeEach(async () => {
      await service.refresh();
    });

    it('should return tool info for an existing tool', () => {
      const info = service.getToolInfo('job_list');
      expect(info).toBeDefined();
      expect(info!.requiresSandbox).toBe(false);
      expect(info!.requiredContext).toContain('dulidayToken');
    });

    it('should return undefined for a non-existent tool', () => {
      const info = service.getToolInfo('non-existent');
      expect(info).toBeUndefined();
    });

    it('should return correct sandbox requirement', () => {
      const bashInfo = service.getToolInfo('bash');
      expect(bashInfo!.requiresSandbox).toBe(true);
    });
  });

  describe('getAvailableModels', () => {
    it('should return empty array before initialization', () => {
      const models = service.getAvailableModels();
      expect(models).toEqual([]);
    });

    it('should return a copy (not the internal reference)', async () => {
      await service.refresh();
      const models1 = service.getAvailableModels();
      const models2 = service.getAvailableModels();
      expect(models1).not.toBe(models2); // Different array instances
      expect(models1).toEqual(models2); // Same content
    });
  });

  describe('getAvailableTools', () => {
    it('should return empty map before initialization', () => {
      const tools = service.getAvailableTools();
      expect(tools.size).toBe(0);
    });

    it('should return a copy of the tools map', async () => {
      await service.refresh();
      const tools1 = service.getAvailableTools();
      const tools2 = service.getAvailableTools();
      expect(tools1).not.toBe(tools2); // Different Map instances
    });
  });

  describe('getConfiguredModel', () => {
    it('should return the configured model from config service', () => {
      expect(service.getConfiguredModel()).toBe('anthropic/claude-3-7-sonnet');
    });
  });

  describe('getConfiguredTools', () => {
    it('should return the configured tools list', () => {
      expect(service.getConfiguredTools()).toEqual(['job_list', 'wework_plan_turn']);
    });

    it('should return empty array when no tools configured', async () => {
      setupConfigMock({ AGENT_ALLOWED_TOOLS: '' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AgentRegistryService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: AgentApiClientService, useValue: mockApiClient },
          { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        ],
      }).compile();

      const emptyService = module.get<AgentRegistryService>(AgentRegistryService);
      expect(emptyService.getConfiguredTools()).toEqual([]);
      emptyService.onModuleDestroy();
    });
  });

  describe('getModelConfig', () => {
    it('should return the model configuration with chatModel and classifyModel', () => {
      const config = service.getModelConfig();
      expect(config).toEqual({
        chatModel: 'anthropic/claude-3-7-sonnet',
        classifyModel: 'anthropic/claude-3-5-haiku',
      });
    });
  });

  describe('getHealthStatus', () => {
    beforeEach(async () => {
      await service.refresh();
    });

    it('should return health status with models info', () => {
      const health = service.getHealthStatus();

      expect(health.models).toBeDefined();
      expect(health.models.available).toContain('anthropic/claude-3-7-sonnet');
      expect(health.models.count).toBe(3);
      expect(health.models.configured).toBe('anthropic/claude-3-7-sonnet');
      expect(health.models.configuredAvailable).toBe(true);
    });

    it('should return health status with tools info', () => {
      const health = service.getHealthStatus();

      expect(health.tools).toBeDefined();
      expect(health.tools.count).toBe(3);
      expect(health.tools.configured).toEqual(['job_list', 'wework_plan_turn']);
    });

    it('should show configuredAvailable false when default model is not in list', async () => {
      setupConfigMock({ AGENT_DEFAULT_MODEL: 'non-existent-model' });

      const module: TestingModule = await Test.createTestingModule({
        providers: [
          AgentRegistryService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: AgentApiClientService, useValue: mockApiClient },
          { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        ],
      }).compile();

      const testService = module.get<AgentRegistryService>(AgentRegistryService);
      await testService.refresh();

      const health = testService.getHealthStatus();
      expect(health.models.configuredAvailable).toBe(false);
      testService.onModuleDestroy();
    });

    it('should include scenario models status', () => {
      const health = service.getHealthStatus();

      expect(health.models.scenarioModels).toBeDefined();
      expect(health.models.scenarioModels.chatModel.configured).toBe('anthropic/claude-3-7-sonnet');
      expect(health.models.scenarioModels.classifyModel.configured).toBe(
        'anthropic/claude-3-5-haiku',
      );
    });

    it('should return null lastRefreshTime before any refresh', async () => {
      // Create a fresh service instance without calling refresh
      setupConfigMock();
      const freshModule: TestingModule = await Test.createTestingModule({
        providers: [
          AgentRegistryService,
          { provide: ConfigService, useValue: mockConfigService },
          { provide: AgentApiClientService, useValue: mockApiClient },
          { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        ],
      }).compile();
      const freshService = freshModule.get<AgentRegistryService>(AgentRegistryService);

      const health = freshService.getHealthStatus();
      expect(health.lastRefreshTime).toBeNull();
      freshService.onModuleDestroy();
    });

    it('should correctly report tool availability', () => {
      const health = service.getHealthStatus();

      const jobListStatus = health.tools.configuredStatus.find((t) => t.name === 'job_list');
      expect(jobListStatus?.available).toBe(true);

      const planTurnStatus = health.tools.configuredStatus.find(
        (t) => t.name === 'wework_plan_turn',
      );
      expect(planTurnStatus?.available).toBe(true);
    });
  });

  describe('isInitialized', () => {
    it('should return false before any data is loaded', () => {
      // Fresh service with no refresh called
      expect(service.isInitialized()).toBe(false);
    });

    it('should return true after models are loaded', async () => {
      await service.refresh();
      expect(service.isInitialized()).toBe(true);
    });

    it('should return true when only tools are loaded', async () => {
      mockApiClient.getModels.mockResolvedValue({ data: { models: [] } });
      mockApiClient.getTools.mockResolvedValue(defaultToolsResponse);

      await service.refresh();
      expect(service.isInitialized()).toBe(true);
    });
  });

  describe('auto-refresh on failure', () => {
    it('should send feishu alert when auto-refresh fails', async () => {
      await service.onModuleInit();

      // Make the next refresh fail
      mockApiClient.getModels.mockRejectedValue(new Error('Auto-refresh network error'));

      // Advance timer to trigger auto-refresh
      jest.advanceTimersByTime(3600000);
      await Promise.resolve();
      await Promise.resolve(); // Extra flush for async operations

      expect(mockFeishuAlertService.sendAlert).toHaveBeenCalledWith(
        expect.objectContaining({
          errorType: 'agent',
          scenario: 'REGISTRY_AUTO_REFRESH_FAILED',
        }),
      );
    });
  });
});
