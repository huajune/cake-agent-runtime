import { Test, TestingModule } from '@nestjs/testing';
import { HttpException } from '@nestjs/common';
import { AgentController } from '@agent/agent.controller';
import { AgentRunnerService } from '@agent/runner.service';
import { AgentHealthService } from '@agent/agent-health.service';
import { FeishuAlertService } from '@infra/feishu/services/alert.service';
import { RegistryService } from '@providers/registry.service';
import { BookingDetectionService } from '@wecom/message/services/booking-detection.service';

describe('AgentController', () => {
  let controller: AgentController;

  const mockLoop = {
    invoke: jest.fn(),
  };

  const mockFeishuAlertService = {
    sendAlert: jest.fn().mockResolvedValue(true),
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

  const mockHealthService = {
    check: jest.fn().mockResolvedValue({
      status: 'healthy',
      message: 'Agent 服务正常',
      providers: ['anthropic', 'deepseek'],
      roles: {
        chat: { model: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-4o'] },
        fast: { model: 'deepseek/deepseek-chat' },
      },
      scenarios: ['candidate-consultation', 'group-operations'],
      tools: {
        builtIn: [
          'advance_stage',
          'recall_history',
          'duliday_job_list',
          'duliday_interview_booking',
        ],
        mcp: [],
        total: 4,
      },
      checks: { redis: true, supabase: true },
    }),
  };

  const mockBookingDetection = {
    handleBookingSuccessAsync: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AgentController],
      providers: [
        { provide: AgentRunnerService, useValue: mockLoop },
        { provide: FeishuAlertService, useValue: mockFeishuAlertService },
        { provide: RegistryService, useValue: mockRegistry },
        { provide: AgentHealthService, useValue: mockHealthService },
        { provide: BookingDetectionService, useValue: mockBookingDetection },
      ],
    }).compile();

    controller = module.get<AgentController>(AgentController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('healthCheck', () => {
    it('should return healthy when all dependencies are available', async () => {
      const result = await controller.healthCheck();

      expect(result.status).toBe('healthy');
      expect(result.message).toBe('Agent 服务正常');
      expect(result.providers).toEqual(['anthropic', 'deepseek']);
      expect(result.roles).toEqual({
        chat: { model: 'anthropic/claude-sonnet-4-6', fallbacks: ['openai/gpt-4o'] },
        fast: { model: 'deepseek/deepseek-chat' },
      });
      expect(result.tools).toEqual({
        builtIn: [
          'advance_stage',
          'recall_history',
          'duliday_job_list',
          'duliday_interview_booking',
        ],
        mcp: [],
        total: 4,
      });
      expect(result.checks).toEqual({ redis: true, supabase: true });
    });

    it('should return unhealthy when Redis is down', async () => {
      mockHealthService.check.mockResolvedValueOnce({
        status: 'unhealthy',
        message: 'Redis 不可用: Connection refused',
        providers: ['anthropic', 'deepseek'],
        roles: {},
        scenarios: [],
        tools: { builtIn: [], mcp: [], total: 0 },
        checks: { redis: false, supabase: true },
      });

      const result = await controller.healthCheck();

      expect(result.status).toBe('unhealthy');
      expect(result.checks.redis).toBe(false);
    });

    it('should return degraded when Supabase is down', async () => {
      mockHealthService.check.mockResolvedValueOnce({
        status: 'degraded',
        message: 'Supabase 不可用: 未初始化',
        providers: ['anthropic', 'deepseek'],
        roles: {},
        scenarios: [],
        tools: { builtIn: [], mcp: [], total: 0 },
        checks: { redis: true, supabase: false },
      });

      const result = await controller.healthCheck();

      expect(result.status).toBe('degraded');
      expect(result.checks.redis).toBe(true);
      expect(result.checks.supabase).toBe(false);
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
      expect(mockBookingDetection.handleBookingSuccessAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          chatId: 'conv123',
          contactName: 'user-1',
          userId: 'user-1',
        }),
      );
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
