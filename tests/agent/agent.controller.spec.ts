import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AgentController } from '@agent/agent.controller';
import { ProfileLoaderService } from '@agent/services/profile-loader.service';
import { OrchestratorService } from '@agent/services/orchestrator.service';
import { ConfigService } from '@nestjs/config';
import { FeishuAlertService } from '@core/feishu';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';

describe('AgentController', () => {
  let controller: AgentController;

  const mockProfileLoader = {
    getProfile: jest.fn(),
    getAllProfiles: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };

  const mockOrchestrator = {
    run: jest.fn(),
    stream: jest.fn(),
  };

  const mockRouter = {
    resolveByRole: jest.fn(),
    listRoles: jest.fn().mockReturnValue(['chat', 'fast']),
  };

  const mockToolRegistry = {
    buildAll: jest.fn(),
    listRegistered: jest.fn().mockReturnValue(['tool1', 'tool2']),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: ProfileLoaderService, useValue: mockProfileLoader },
        { provide: ConfigService, useValue: mockConfigService },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        { provide: OrchestratorService, useValue: mockOrchestrator },
        { provide: RouterService, useValue: mockRouter },
        { provide: ToolRegistryService, useValue: mockToolRegistry },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return healthy status with provider roles', () => {
      const result = controller.healthCheck();

      expect(result.status).toBe('healthy');
      expect(result.providers).toEqual(['chat', 'fast']);
    });
  });

  describe('getProfiles', () => {
    it('should return all profiles with sanitized fields', () => {
      mockProfileLoader.getAllProfiles.mockReturnValue([
        {
          name: 'test',
          description: 'Test profile',
          model: 'anthropic/claude-sonnet-4-6',
          allowedTools: ['tool1'],
          context: 'secret',
          contextStrategy: 'skip',
          prune: true,
        },
      ]);

      const result = controller.getProfiles();

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test');
      expect(result[0]).not.toHaveProperty('context');
    });
  });

  describe('getProfile', () => {
    it('should return sanitized profile when exists', () => {
      const mockProfile = {
        name: 'test-profile',
        description: 'Test',
        model: 'test-model',
        allowedTools: ['tool1', 'tool2'],
        contextStrategy: 'skip',
        prune: true,
        pruneOptions: { maxTokens: 1000 },
        context: { apiKey: 'secret-key' },
        toolContext: { internalConfig: 'confidential' },
        systemPrompt: 'System instructions',
      };

      mockProfileLoader.getProfile.mockReturnValue(mockProfile);

      const result = controller.getProfile('test-profile');

      expect(mockProfileLoader.getProfile).toHaveBeenCalledWith('test-profile');
      expect(result).toEqual({
        name: 'test-profile',
        description: 'Test',
        model: 'test-model',
        allowedTools: ['tool1', 'tool2'],
        contextStrategy: 'skip',
        prune: true,
        pruneOptions: { maxTokens: 1000 },
      });
      expect(result).not.toHaveProperty('context');
      expect(result).not.toHaveProperty('toolContext');
      expect(result).not.toHaveProperty('systemPrompt');
    });

    it('should throw 404 when profile not found', () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      expect(() => controller.getProfile('non-existent')).toThrow(
        '未找到场景 non-existent 的配置',
      );
    });
  });

  describe('debugChat', () => {
    it('should call orchestrator.run with correct parameters', async () => {
      mockOrchestrator.run.mockResolvedValue({
        text: '你好！',
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const result = await controller.debugChat({
        message: '你好',
        sessionId: 'conv123',
        scenario: 'candidate-consultation',
        userId: 'user-1',
      });

      expect(mockOrchestrator.run).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: '你好' }],
        userId: 'user-1',
        corpId: 'debug',
        scenario: 'candidate-consultation',
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('你好！');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    });

    it('should use defaults when optional params not provided', async () => {
      mockOrchestrator.run.mockResolvedValue({
        text: 'response',
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const result = await controller.debugChat({ message: '测试' });

      expect(mockOrchestrator.run).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: '测试' }],
        userId: 'debug-user',
        corpId: 'debug',
        scenario: 'candidate-consultation',
      });
      expect(result.success).toBe(true);
    });

    it('should throw HttpException when orchestrator fails', async () => {
      mockOrchestrator.run.mockRejectedValue(new Error('Agent failed'));
      mockFeishuAlertService.sendAlert.mockResolvedValue(true);

      await expect(controller.debugChat({ message: '测试' })).rejects.toThrow(HttpException);
    });
  });
});
