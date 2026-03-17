import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AgentController } from '@agent/agent.controller';
import { LoopService } from '@agent/loop.service';
import { ContextService } from '@agent/context/context.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { RouterService } from '@providers/router.service';

describe('AgentController', () => {
  let controller: AgentController;

  const mockContext = {
    compose: jest.fn().mockResolvedValue({
      systemPrompt: 'test system prompt',
      stageGoals: { initial: { description: 'test' } },
    }),
    getLoadedScenarios: jest.fn().mockReturnValue(['candidate-consultation', 'group-operations']),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
  };

  const mockLoop = {
    run: jest.fn(),
    stream: jest.fn(),
  };

  const mockRouter = {
    resolveByRole: jest.fn(),
    listRoles: jest.fn().mockReturnValue(['chat', 'fast']),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: ContextService, useValue: mockContext },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        { provide: LoopService, useValue: mockLoop },
        { provide: RouterService, useValue: mockRouter },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    jest.clearAllMocks();
    mockContext.compose.mockResolvedValue({
      systemPrompt: 'test system prompt',
      stageGoals: { initial: { description: 'test' } },
    });
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return healthy status with provider roles and scenarios', () => {
      const result = controller.healthCheck();

      expect(result.status).toBe('healthy');
      expect(result.providers).toEqual(['chat', 'fast']);
      expect(result.scenarios).toEqual(['candidate-consultation', 'group-operations']);
    });
  });

  describe('debugChat', () => {
    it('should compose prompt then call loop.run with correct parameters', async () => {
      mockLoop.run.mockResolvedValue({
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

      expect(mockContext.compose).toHaveBeenCalledWith({ scenario: 'candidate-consultation' });
      expect(mockLoop.run).toHaveBeenCalledWith({
        systemPrompt: 'test system prompt',
        stageGoals: { initial: { description: 'test' } },
        messages: [{ role: 'user', content: '你好' }],
        userId: 'user-1',
        corpId: 'debug',
      });
      expect(result.success).toBe(true);
      expect(result.text).toBe('你好！');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20, totalTokens: 30 });
    });

    it('should use defaults when optional params not provided', async () => {
      mockLoop.run.mockResolvedValue({
        text: 'response',
        steps: 1,
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const result = await controller.debugChat({ message: '测试' });

      expect(mockContext.compose).toHaveBeenCalledWith({ scenario: 'candidate-consultation' });
      expect(mockLoop.run).toHaveBeenCalledWith({
        systemPrompt: 'test system prompt',
        stageGoals: { initial: { description: 'test' } },
        messages: [{ role: 'user', content: '测试' }],
        userId: 'debug-user',
        corpId: 'debug',
      });
      expect(result.success).toBe(true);
    });

    it('should throw HttpException when loop fails', async () => {
      mockLoop.run.mockRejectedValue(new Error('Agent failed'));
      mockFeishuAlertService.sendAlert.mockResolvedValue(true);

      await expect(controller.debugChat({ message: '测试' })).rejects.toThrow(HttpException);
    });
  });
});
