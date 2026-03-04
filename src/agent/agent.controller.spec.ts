import { Test, TestingModule } from '@nestjs/testing';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ProfileLoaderService } from './services/agent-profile-loader.service';
import { AgentConfigValidator } from './utils/agent-validator';
import { AgentRegistryService } from './services/agent-registry.service';
import { ConfigService } from '@nestjs/config';
import { FeishuAlertService } from '@core/feishu';
import { AgentFacadeService } from './services/agent-facade.service';

describe('AgentController', () => {
  let controller: AgentController;
  let service: AgentService;
  let registryService: AgentRegistryService;

  const mockAgentService = {
    getTools: jest.fn(),
    getModels: jest.fn(),
    chat: jest.fn(),
    chatWithProfile: jest.fn(),
  };

  const mockRegistryService = {
    getHealthStatus: jest.fn(),
    getConfiguredTools: jest.fn(),
    getAvailableModels: jest.fn(),
    refresh: jest.fn(),
  };

  const mockProfileLoader = {
    getProfile: jest.fn(),
    getAllProfiles: jest.fn(),
    reloadProfile: jest.fn(),
    reloadAllProfiles: jest.fn(),
    hasProfile: jest.fn(),
    deleteProfile: jest.fn(),
  };

  const mockConfigValidator = {
    validateRequiredFields: jest.fn(),
    validateContext: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
    sendSimpleAlert: jest.fn().mockResolvedValue(true),
  };

  const mockAgentFacadeService = {
    chatWithScenario: jest.fn(),
    chatStreamWithScenario: jest.fn(),
    getProfile: jest.fn(),
    hasScenario: jest.fn(),
    getAllScenarios: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        {
          provide: AgentService,
          useValue: mockAgentService,
        },
        {
          provide: AgentRegistryService,
          useValue: mockRegistryService,
        },
        {
          provide: ProfileLoaderService,
          useValue: mockProfileLoader,
        },
        {
          provide: AgentConfigValidator,
          useValue: mockConfigValidator,
        },
        {
          provide: ConfigService,
          useValue: mockConfigService,
        },
        {
          provide: FeishuAlertService,
          useValue: mockFeishuAlertService,
        },
        {
          provide: AgentFacadeService,
          useValue: mockAgentFacadeService,
        },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    service = module.get<AgentService>(AgentService);
    registryService = module.get<AgentRegistryService>(AgentRegistryService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return healthy status when all configured resources are available', async () => {
      const mockHealthStatus = {
        models: { configuredAvailable: true },
        tools: { allAvailable: true },
        lastRefreshTime: new Date().toISOString(),
      };

      mockRegistryService.getHealthStatus.mockReturnValue(mockHealthStatus);

      const result = await controller.healthCheck();

      expect(registryService.getHealthStatus).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.status).toEqual('healthy');
    });

    it('should return degraded status when some resources are unavailable', async () => {
      const mockHealthStatus = {
        models: { configuredAvailable: true },
        tools: { allAvailable: false },
        lastRefreshTime: new Date().toISOString(),
      };

      mockRegistryService.getHealthStatus.mockReturnValue(mockHealthStatus);

      const result = await controller.healthCheck();

      expect(registryService.getHealthStatus).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.status).toEqual('degraded');
    });
  });

  describe('getTools', () => {
    it('should call agentService.getTools', async () => {
      const mockResult = {
        tools: ['tool1', 'tool2', 'tool3'],
        count: 3,
      };

      mockAgentService.getTools.mockResolvedValue(mockResult);

      const result = await controller.getTools();

      expect(service.getTools).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should handle empty tools list', async () => {
      const mockResult = { tools: [], count: 0 };

      mockAgentService.getTools.mockResolvedValue(mockResult);

      const result = await controller.getTools();

      expect(service.getTools).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from agentService.getTools', async () => {
      const error = new Error('Get tools failed');

      mockAgentService.getTools.mockRejectedValue(error);

      await expect(controller.getTools()).rejects.toThrow('Get tools failed');
    });
  });

  describe('getModels', () => {
    it('should call agentService.getModels', async () => {
      const mockResult = {
        models: ['gpt-3.5-turbo', 'gpt-4', 'claude-3'],
        count: 3,
      };

      mockAgentService.getModels.mockResolvedValue(mockResult);

      const result = await controller.getModels();

      expect(service.getModels).toHaveBeenCalled();
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from agentService.getModels', async () => {
      const error = new Error('Get models failed');

      mockAgentService.getModels.mockRejectedValue(error);

      await expect(controller.getModels()).rejects.toThrow('Get models failed');
    });
  });

  describe('debugChat', () => {
    const createMockAgentResult = (text: string) => ({
      status: 'success',
      data: {
        messages: [{ role: 'assistant', parts: [{ type: 'text', text }] }],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      fromCache: false,
      correlationId: 'test-correlation-id',
    });

    it('should call agentFacade.chatWithScenario with correct parameters', async () => {
      const mockBody = {
        message: '你好',
        sessionId: 'conv123',
        scenario: 'candidate-consultation',
        model: 'gpt-4',
      };
      const mockAgentResult = createMockAgentResult('你好！');

      mockAgentFacadeService.chatWithScenario.mockResolvedValue(mockAgentResult);

      const result = await controller.debugChat(mockBody);

      expect(mockAgentFacadeService.chatWithScenario).toHaveBeenCalledWith(
        'candidate-consultation',
        'conv123',
        '你好',
        {
          model: 'gpt-4',
          allowedTools: undefined,
          userId: undefined,
        },
      );
      expect(result.success).toBe(true);
      expect(result.sessionId).toBe('conv123');
      expect(result.scenario).toBe('candidate-consultation');
      expect(result.agentResult.status).toBe('success');
      expect(result.agentResult.data).toEqual(mockAgentResult.data);
    });

    it('should use default sessionId and scenario when not provided', async () => {
      const mockBody = { message: '测试消息' };
      const mockAgentResult = createMockAgentResult('收到测试消息');

      mockAgentFacadeService.chatWithScenario.mockResolvedValue(mockAgentResult);

      const result = await controller.debugChat(mockBody);

      expect(mockAgentFacadeService.chatWithScenario).toHaveBeenCalledWith(
        'candidate-consultation',
        expect.stringMatching(/^debug-\d+$/),
        '测试消息',
        expect.objectContaining({ model: undefined, allowedTools: undefined }),
      );
      expect(result.success).toBe(true);
      expect(result.scenario).toBe('candidate-consultation');
    });

    it('should use custom scenario when provided', async () => {
      const mockBody = {
        message: '你好',
        scenario: 'wechat-group-assistant',
      };
      const mockAgentResult = createMockAgentResult('你好！');

      mockAgentFacadeService.chatWithScenario.mockResolvedValue(mockAgentResult);

      const result = await controller.debugChat(mockBody);

      expect(mockAgentFacadeService.chatWithScenario).toHaveBeenCalledWith(
        'wechat-group-assistant',
        expect.stringMatching(/^debug-\d+$/),
        '你好',
        expect.any(Object),
      );
      expect(result.scenario).toBe('wechat-group-assistant');
    });

    it('should return success false when result status is error', async () => {
      const mockBody = { message: '测试' };
      const mockErrorResult = {
        status: 'error',
        error: { message: 'Agent 调用失败', retryable: false },
      };

      mockAgentFacadeService.chatWithScenario.mockResolvedValue(mockErrorResult);

      const result = await controller.debugChat(mockBody);

      expect(result.success).toBe(false);
      expect(result.agentResult.status).toBe('error');
      expect(result.agentResult.error).toEqual(mockErrorResult.error);
    });

    it('should handle errors from agentFacade.chatWithScenario', async () => {
      const mockBody = { message: '测试' };

      mockAgentFacadeService.chatWithScenario.mockRejectedValue(new Error('Chat failed'));

      await expect(controller.debugChat(mockBody)).rejects.toThrow('Chat failed');
    });
  });

  describe('getProfile', () => {
    it('should return sanitized profile when exists', async () => {
      const mockProfile = {
        name: 'test-profile',
        description: 'Test',
        model: 'test-model',
        allowedTools: ['tool1', 'tool2'],
        contextStrategy: 'skip',
        prune: true,
        pruneOptions: { maxTokens: 1000 },
        // 敏感字段（不应该出现在响应中）
        context: { apiKey: 'secret-key' },
        toolContext: { internalConfig: 'confidential' },
        systemPrompt: 'System instructions',
      };

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);

      const result = await controller.getProfile('test-profile');

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('test-profile');
      // 验证返回脱敏后的版本
      expect(result).toEqual({
        name: 'test-profile',
        description: 'Test',
        model: 'test-model',
        allowedTools: ['tool1', 'tool2'],
        contextStrategy: 'skip',
        prune: true,
        pruneOptions: { maxTokens: 1000 },
      });
      // 验证敏感字段被移除
      expect(result).not.toHaveProperty('context');
      expect(result).not.toHaveProperty('toolContext');
      expect(result).not.toHaveProperty('systemPrompt');
    });

    it('should throw 404 when profile not found', async () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      await expect(controller.getProfile('non-existent')).rejects.toThrow(
        '未找到场景 non-existent 的配置',
      );
    });
  });

  describe('validateProfile', () => {
    it('should validate profile successfully', async () => {
      const mockProfile = {
        name: 'test-profile',
        description: 'Test',
        model: 'test-model',
        context: [],
      };

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockConfigValidator.validateRequiredFields.mockReturnValue(undefined);
      mockConfigValidator.validateContext.mockReturnValue({
        isValid: true,
        errors: [],
      });

      const result = await controller.validateProfile('test-profile');

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('test-profile');
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
    });

    it('should throw 404 when profile not found for validation', async () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      await expect(controller.validateProfile('non-existent')).rejects.toThrow(
        '未找到场景 non-existent 的配置',
      );
    });
  });
});
