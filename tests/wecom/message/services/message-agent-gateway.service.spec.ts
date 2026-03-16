import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentGatewayService } from '@wecom/message/services/message-agent-gateway.service';
import { AgentFacadeService } from '@agent/services/agent-facade.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { ScenarioType, AgentResultHelper } from '@agent';

// Mock the AgentResultHelper module
jest.mock('@agent', () => ({
  ...jest.requireActual('@agent'),
  AgentResultHelper: {
    isError: jest.fn(),
    isFallback: jest.fn(),
    getResponse: jest.fn(),
  },
  ScenarioType: {
    CANDIDATE_CONSULTATION: 'candidate_consultation',
  },
  AgentInvocationException: class AgentInvocationException extends Error {
    constructor(
      public code: string,
      message: string,
      public meta?: Record<string, unknown>,
    ) {
      super(message);
      this.name = 'AgentInvocationException';
    }
  },
}));

describe('AgentGatewayService', () => {
  let service: AgentGatewayService;

  const mockAgentFacade = {
    chatWithScenario: jest.fn(),
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

  const validChatResponse = {
    messages: [
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello! How can I help you today?' }],
      },
    ],
    usage: {
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    },
  };

  const validAgentResult = {
    response: validChatResponse,
    fallbackInfo: null,
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentGatewayService,
        { provide: AgentFacadeService, useValue: mockAgentFacade },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<AgentGatewayService>(AgentGatewayService);
    jest.clearAllMocks();

    (AgentResultHelper.isError as jest.Mock).mockReturnValue(false);
    (AgentResultHelper.isFallback as jest.Mock).mockReturnValue(false);
    (AgentResultHelper.getResponse as jest.Mock).mockReturnValue(validChatResponse);

    mockAgentFacade.chatWithScenario.mockResolvedValue(validAgentResult);
    mockMonitoringService.recordAiStart.mockReturnValue(undefined);
    mockMonitoringService.recordAiEnd.mockReturnValue(undefined);
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
      historyMessages: [],
      scenario: ScenarioType.CANDIDATE_CONSULTATION,
      messageId: 'msg-123',
      recordMonitoring: true,
      userId: 'user-123',
    };

    it('should successfully invoke agent and return result', async () => {
      const result = await service.invoke(invokeParams);

      expect(result.reply.content).toBe('Hello! How can I help you today?');
      expect(result.isFallback).toBe(false);
      expect(result.processingTime).toBeGreaterThanOrEqual(0);
      expect(mockAgentFacade.chatWithScenario).toHaveBeenCalledWith(
        ScenarioType.CANDIDATE_CONSULTATION,
        'chat-123',
        'Hello',
        expect.objectContaining({ messages: [], userId: 'user-123' }),
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
      (AgentResultHelper.isError as jest.Mock).mockReturnValue(true);
      const agentErrorResult = {
        error: { code: 'TEST_ERROR', message: 'Test error' },
      };
      mockAgentFacade.chatWithScenario.mockResolvedValue(agentErrorResult);

      await expect(service.invoke(invokeParams)).rejects.toThrow();

      expect(mockMonitoringService.recordAiEnd).toHaveBeenCalledWith('msg-123');
    });

    it('should throw when Agent returns error result', async () => {
      (AgentResultHelper.isError as jest.Mock).mockReturnValue(true);
      mockAgentFacade.chatWithScenario.mockResolvedValue({
        error: { code: 'AUTH_ERROR', message: 'Invalid API key' },
      });

      await expect(service.invoke(invokeParams)).rejects.toThrow();
    });

    it('should throw when agent returns empty response', async () => {
      (AgentResultHelper.isError as jest.Mock).mockReturnValue(false);
      (AgentResultHelper.getResponse as jest.Mock).mockReturnValue(null);

      await expect(service.invoke(invokeParams)).rejects.toThrow('Agent 返回空响应');
    });

    it('should detect fallback response and set isFallback=true', async () => {
      (AgentResultHelper.isFallback as jest.Mock).mockReturnValue(true);
      mockAgentFacade.chatWithScenario.mockResolvedValue({
        ...validAgentResult,
        fallbackInfo: { reason: 'Context missing' },
      });

      const result = await service.invoke(invokeParams);

      expect(result.isFallback).toBe(true);
    });

    it('should use default scenario when none provided', async () => {
      const paramsWithoutScenario = {
        sessionId: 'chat-123',
        userMessage: 'Hello',
        historyMessages: [],
        userId: 'user-123',
      };

      await service.invoke(paramsWithoutScenario);

      expect(mockAgentFacade.chatWithScenario).toHaveBeenCalledWith(
        ScenarioType.CANDIDATE_CONSULTATION,
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    });

    it('should throw when no text content in assistant messages', async () => {
      const noTextResponse = {
        messages: [
          {
            role: 'assistant',
            parts: [{ type: 'image', url: 'http://example.com/img.jpg' }],
          },
        ],
      };
      (AgentResultHelper.getResponse as jest.Mock).mockReturnValue(noTextResponse);

      await expect(service.invoke(invokeParams)).rejects.toThrow('AI 响应中没有找到文本内容');
    });

    it('should throw when messages array is empty', async () => {
      const emptyMessagesResponse = { messages: [] };
      (AgentResultHelper.getResponse as jest.Mock).mockReturnValue(emptyMessagesResponse);

      await expect(service.invoke(invokeParams)).rejects.toThrow('AI 未生成有效回复');
    });

    it('should throw when no assistant message found', async () => {
      const onlyUserMessages = {
        messages: [{ role: 'user', parts: [{ type: 'text', text: 'User question' }] }],
      };
      (AgentResultHelper.getResponse as jest.Mock).mockReturnValue(onlyUserMessages);

      await expect(service.invoke(invokeParams)).rejects.toThrow();
    });

    it('should include usage data in reply', async () => {
      const result = await service.invoke(invokeParams);

      expect(result.reply.usage).toMatchObject({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('should rethrow error when facade throws directly', async () => {
      mockAgentFacade.chatWithScenario.mockRejectedValue(new Error('Network timeout'));

      await expect(service.invoke(invokeParams)).rejects.toThrow('Network timeout');
    });
  });
});
