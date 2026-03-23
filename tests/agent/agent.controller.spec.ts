import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AgentController } from '@agent/agent.controller';
import { AgentRunnerService } from '@agent/runner.service';
import { ContextService } from '@agent/context/context.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { RouterService } from '@providers/router.service';
import { RegistryService } from '@providers/registry.service';

describe('AgentController', () => {
  let controller: AgentController;

  const mockLoop = {
    invoke: jest.fn(),
  };

  const mockContext = {
    getLoadedScenarios: jest.fn().mockReturnValue(['candidate-consultation', 'group-operations']),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };

  const mockRouter = {
    resolveByRole: jest.fn(),
    listRoles: jest.fn().mockReturnValue(['chat', 'fast']),
    listRoleDetails: jest.fn().mockReturnValue({
      chat: { model: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-4o'] },
      fast: { model: 'deepseek/deepseek-chat' },
    }),
  };

  const mockModels = [
    {
      id: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      name: 'Claude Sonnet 4.6',
      description: 'Anthropic Claude Sonnet 4.6 (最新)',
    },
    {
      id: 'deepseek/deepseek-chat',
      provider: 'deepseek',
      name: 'DeepSeek Chat',
      description: 'DeepSeek V3',
    },
  ];

  const mockRegistry = {
    listProviders: jest.fn().mockReturnValue(['anthropic', 'deepseek']),
    listModels: jest.fn().mockReturnValue(mockModels),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentRunnerService, useValue: mockLoop },
        { provide: ContextService, useValue: mockContext },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        { provide: RouterService, useValue: mockRouter },
        { provide: RegistryService, useValue: mockRegistry },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return healthy status with providers, roles and scenarios', () => {
      const result = controller.healthCheck();

      expect(result.status).toBe('healthy');
      expect(result.providers).toEqual(['anthropic', 'deepseek']);
      expect(result.roles).toEqual({
        chat: { model: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-4o'] },
        fast: { model: 'deepseek/deepseek-chat' },
      });
      expect(result.scenarios).toEqual(['candidate-consultation', 'group-operations']);
    });
  });

  describe('listModels', () => {
    it('should return available models with total count', () => {
      const result = controller.listModels();

      expect(result.models).toEqual(mockModels);
      expect(result.total).toBe(2);
      expect(mockRegistry.listModels).toHaveBeenCalled();
    });
  });

  describe('debugChat', () => {
    it('should call AgentRunnerService.invoke with correct parameters', async () => {
      mockLoop.invoke.mockResolvedValue({
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

      expect(mockLoop.invoke).toHaveBeenCalledWith({
        messages: [{ role: 'user', content: '你好' }],
        userId: 'user-1',
        corpId: 'debug',
        sessionId: 'conv123',
        scenario: 'candidate-consultation',
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('你好！');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    });

    it('should use defaults when optional params not provided', async () => {
      mockLoop.invoke.mockResolvedValue({
        text: 'response',
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const result = await controller.debugChat({ message: '测试' });

      expect(mockLoop.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [{ role: 'user', content: '测试' }],
          userId: 'debug-user',
          corpId: 'debug',
          scenario: 'candidate-consultation',
        }),
      );
      expect(result.success).toBe(true);
    });

    it('should throw HttpException when AgentRunnerService fails', async () => {
      mockLoop.invoke.mockRejectedValue(new Error('Agent failed'));
      mockFeishuAlertService.sendAlert.mockResolvedValue(true);

      await expect(controller.debugChat({ message: '测试' })).rejects.toThrow(HttpException);
    });
  });
});
