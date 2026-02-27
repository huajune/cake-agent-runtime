import { Test, TestingModule } from '@nestjs/testing';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';
import { ProfileLoaderService } from './services/agent-profile-loader.service';
import { BrandConfigService } from './services/brand-config.service';
import { AgentConfigValidator } from './utils/agent-validator';
import { AgentRegistryService } from './services/agent-registry.service';
import { ConfigService } from '@nestjs/config';
import { FeishuAlertService } from '@core/feishu';

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

  const mockBrandConfig = {
    getBrandConfigStatus: jest.fn(),
    refreshBrandConfig: jest.fn(),
    getBrandConfig: jest.fn(),
  };

  const mockConfigValidator = {
    validateBrandConfig: jest.fn(),
    validateRequiredFields: jest.fn(),
    validateContext: jest.fn(),
    logValidationWarnings: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
    sendSimpleAlert: jest.fn().mockResolvedValue(true),
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
          provide: BrandConfigService,
          useValue: mockBrandConfig,
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

      const mockBrandConfigStatus = {
        available: true,
        synced: true,
        hasBrandData: true,
        hasReplyPrompts: true,
        lastRefreshTime: new Date().toISOString(),
      };

      mockRegistryService.getHealthStatus.mockReturnValue(mockHealthStatus);
      mockBrandConfig.getBrandConfigStatus.mockResolvedValue(mockBrandConfigStatus);

      const result = await controller.healthCheck();

      expect(registryService.getHealthStatus).toHaveBeenCalled();
      expect(mockBrandConfig.getBrandConfigStatus).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.status).toEqual('healthy');
      // 验证不返回完整品牌配置数据
      expect(result.data.brandConfig.available).toBe(true);
      expect(result.data.brandConfig.synced).toBe(true);
      expect(result.data.brandConfig).not.toHaveProperty('data');
    });

    it('should return degraded status when some resources are unavailable', async () => {
      const mockHealthStatus = {
        models: { configuredAvailable: true },
        tools: { allAvailable: false },
        lastRefreshTime: new Date().toISOString(),
      };

      const mockBrandConfigStatus = {
        available: true,
        synced: true,
        hasBrandData: true,
        hasReplyPrompts: true,
        lastRefreshTime: new Date().toISOString(),
      };

      mockRegistryService.getHealthStatus.mockReturnValue(mockHealthStatus);
      mockBrandConfig.getBrandConfigStatus.mockResolvedValue(mockBrandConfigStatus);

      const result = await controller.healthCheck();

      expect(registryService.getHealthStatus).toHaveBeenCalled();
      expect(mockBrandConfig.getBrandConfigStatus).toHaveBeenCalled();
      expect(result.success).toBe(true);
      expect(result.data.status).toEqual('degraded');
      // 验证不返回完整品牌配置数据
      expect(result.data.brandConfig).not.toHaveProperty('data');
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

  describe('testChat', () => {
    const mockProfile = {
      name: 'candidate-consultation',
      description: '测试配置',
      model: 'test-model',
      context: [],
      toolContext: {},
    };

    const createMockAgentResult = (text: string) => ({
      status: 'success',
      data: {
        messages: [{ role: 'assistant', parts: [{ type: 'text', text }] }],
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      },
      fromCache: false,
      correlationId: 'test-correlation-id',
    });

    it('should call agentService.chatWithProfile with all parameters', async () => {
      const mockBody = {
        message: '你好',
        conversationId: 'conv123',
        model: 'gpt-4',
      };
      const mockAgentResult = createMockAgentResult('你好！');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('candidate-consultation');
      expect(service.chatWithProfile).toHaveBeenCalledWith('conv123', '你好', mockProfile, {
        model: 'gpt-4',
        allowedTools: undefined,
      });
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
    });

    it('should use default conversationId when not provided', async () => {
      const mockBody = { message: '测试消息' };
      const mockAgentResult = createMockAgentResult('收到测试消息');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('candidate-consultation');
      expect(service.chatWithProfile).toHaveBeenCalledWith('test-user', '测试消息', mockProfile, {
        model: undefined,
        allowedTools: undefined,
      });
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
    });

    it('should call agentService.chatWithProfile without model parameter', async () => {
      const mockBody = {
        message: '你好',
        conversationId: 'conv456',
      };
      const mockAgentResult = createMockAgentResult('你好！');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('candidate-consultation');
      expect(service.chatWithProfile).toHaveBeenCalledWith('conv456', '你好', mockProfile, {
        model: undefined,
        allowedTools: undefined,
      });
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
    });

    it('should handle errors from agentService.chatWithProfile', async () => {
      const mockBody = { message: '测试' };
      const error = new Error('Chat failed');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockRejectedValue(error);

      await expect(controller.testChat(mockBody)).rejects.toThrow('Chat failed');
    });

    it('should throw 404 when scenario is not found', async () => {
      const mockBody = {
        message: '你好',
        scenario: 'non-existent-scenario',
      };

      mockProfileLoader.getProfile.mockReturnValue(null);

      await expect(controller.testChat(mockBody)).rejects.toThrow(
        '未找到场景 non-existent-scenario 的配置，请检查配置文件',
      );
    });

    it('should use custom scenario when provided', async () => {
      const mockBody = {
        message: '你好',
        scenario: 'wechat-group-assistant',
      };
      const mockAgentResult = createMockAgentResult('你好！');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('wechat-group-assistant');
      expect(service.chatWithProfile).toHaveBeenCalledWith('test-user', '你好', mockProfile, {
        model: undefined,
        allowedTools: undefined,
      });
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
    });

    it('should pass allowedTools to chatWithProfile when provided', async () => {
      const mockBody = {
        message: '帮我查询职位',
        allowedTools: ['duliday_job_list', 'duliday_job_details'],
      };
      const mockAgentResult = createMockAgentResult('正在查询职位...');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('candidate-consultation');
      expect(service.chatWithProfile).toHaveBeenCalledWith(
        'test-user',
        '帮我查询职位',
        mockProfile,
        {
          model: undefined,
          allowedTools: ['duliday_job_list', 'duliday_job_details'],
        },
      );
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
    });

    it('should pass both custom scenario and allowedTools', async () => {
      const mockBody = {
        message: '帮我查询职位',
        scenario: 'wechat-group-assistant',
        allowedTools: ['duliday_job_list'],
        conversationId: 'custom-conv-123',
      };
      const mockAgentResult = createMockAgentResult('正在查询...');

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);
      mockAgentService.chatWithProfile.mockResolvedValue(mockAgentResult);

      const result = await controller.testChat(mockBody);

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('wechat-group-assistant');
      expect(service.chatWithProfile).toHaveBeenCalledWith(
        'custom-conv-123',
        '帮我查询职位',
        mockProfile,
        {
          model: undefined,
          allowedTools: ['duliday_job_list'],
        },
      );
      expect(result).toEqual({
        response: mockAgentResult.data,
        metadata: {
          status: 'success',
          fromCache: false,
          correlationId: 'test-correlation-id',
        },
      });
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
      mockConfigValidator.validateBrandConfig.mockReturnValue({
        isValid: true,
        errors: [],
      });
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
