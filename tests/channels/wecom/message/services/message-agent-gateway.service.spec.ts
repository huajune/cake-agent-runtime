import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentGatewayService } from '@wecom/message/services/message-agent-gateway.service';
import { OrchestratorService } from '@agent/services/orchestrator.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;

  const mockOrchestrator = {
    run: jest.fn(),
  };

  const mockMonitoringService = {
    recordAiStart: jest.fn(),
    recordAiEnd: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'AGENT_FALLBACK_MESSAGE') return '';
      return defaultValue;
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentGatewayService,
        { provide: OrchestratorService, useValue: mockOrchestrator },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AgentGatewayService>(AgentGatewayService);
    jest.clearAllMocks();

    mockOrchestrator.run.mockResolvedValue({
      text: 'Hello! How can I help you today?',
      steps: 1,
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getFallbackMessage', () => {
    it('should return custom message when provided', () => {
      const result = service.getFallbackMessage({ customMessage: 'Custom fallback message' });
      expect(result).toBe('Custom fallback message');
    });

    it('should return env message when configured', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'AGENT_FALLBACK_MESSAGE') return 'Env fallback message';
        return undefined;
      });

      const result = service.getFallbackMessage();
      expect(result).toBe('Env fallback message');
    });

    it('should return first default message when random=false', () => {
      const result = service.getFallbackMessage({ random: false });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should return a random default message when no options provided', () => {
      const result = service.getFallbackMessage();
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('should prioritize customMessage over env config', () => {
      mockConfigService.get.mockImplementation((key: string) => {
        if (key === 'AGENT_FALLBACK_MESSAGE') return 'Env message';
        return undefined;
      });

      const result = service.getFallbackMessage({ customMessage: 'Custom overrides env' });
      expect(result).toBe('Custom overrides env');
    });
  });

  describe('invoke', () => {
    const invokeParams = {
      sessionId: 'chat-123',
      userMessage: 'Hello',
      historyMessages: [] as { role: string; content: string }[],
      scenario: 'candidate-consultation',
      messageId: 'msg-123',
      recordMonitoring: true,
      userId: 'user-123',
    };

    it('should successfully invoke orchestrator and return result', async () => {
      const result = await service.invoke(invokeParams);

      expect(result.reply.content).toBe('Hello! How can I help you today?');
      expect(result.isFallback).toBe(false);
      expect(result.processingTime).toBeGreaterThanOrEqual(0);
      expect(mockOrchestrator.run).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'user-123',
          scenario: 'candidate-consultation',
        }),
      );
    });

    it('should record AI monitoring when recordMonitoring=true and messageId provided', async () => {
      await service.invoke(invokeParams);

      expect(mockMonitoringService.recordAiStart).toHaveBeenCalledWith('msg-123');
      expect(mockMonitoringService.recordAiEnd).toHaveBeenCalledWith('msg-123');
    });

    it('should not record monitoring when recordMonitoring=false', async () => {
      await service.invoke({ ...invokeParams, recordMonitoring: false });

      expect(mockMonitoringService.recordAiStart).not.toHaveBeenCalled();
    });

    it('should always record AI end in finally block even on error', async () => {
      mockOrchestrator.run.mockRejectedValue(new Error('Agent failed'));

      await expect(service.invoke(invokeParams)).rejects.toThrow('Agent failed');

      expect(mockMonitoringService.recordAiEnd).toHaveBeenCalledWith('msg-123');
    });

    it('should throw when agent returns empty text', async () => {
      mockOrchestrator.run.mockResolvedValue({
        text: '',
        steps: 0,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });

      await expect(service.invoke(invokeParams)).rejects.toThrow('Agent 返回空响应');
    });

    it('should use default scenario when none provided', async () => {
      const paramsWithoutScenario = {
        sessionId: 'chat-123',
        userMessage: 'Hello',
        historyMessages: [],
        userId: 'user-123',
      };

      await service.invoke(paramsWithoutScenario);

      expect(mockOrchestrator.run).toHaveBeenCalledWith(
        expect.objectContaining({
          scenario: 'candidate-consultation',
        }),
      );
    });

    it('should include usage data in reply', async () => {
      const result = await service.invoke(invokeParams);

      expect(result.reply.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('should rethrow error when orchestrator throws', async () => {
      mockOrchestrator.run.mockRejectedValue(new Error('Network timeout'));

      await expect(service.invoke(invokeParams)).rejects.toThrow('Network timeout');
    });

    it('should build messages from history and current user message', async () => {
      const paramsWithHistory = {
        ...invokeParams,
        historyMessages: [
          { role: 'user', content: 'Previous question' },
          { role: 'assistant', content: 'Previous answer' },
        ],
      };

      await service.invoke(paramsWithHistory);

      const callArgs = mockOrchestrator.run.mock.calls[0][0];
      expect(callArgs.messages).toEqual([
        { role: 'user', content: 'Previous question' },
        { role: 'assistant', content: 'Previous answer' },
        { role: 'user', content: 'Hello' },
      ]);
    });
  });
});
