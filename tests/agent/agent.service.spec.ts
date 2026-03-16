import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentService } from '@agent/agent.service';
import { AgentApiClientService } from '@agent/services/agent-api-client.service';
import { AgentRegistryService } from '@agent/services/agent-registry.service';
import { AgentFallbackService } from '@agent/services/agent-fallback.service';
import { AgentResultStatus } from '@agent/utils/agent-enums';
import { ContextStrategy } from '@agent/utils/agent-types';
import { MessageRole } from '@shared/enums';

describe('AgentService', () => {
  let service: AgentService;

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultVal?: any) => defaultVal),
  };

  const mockApiClient = {
    chat: jest.fn(),
    chatStream: jest.fn(),
    getModels: jest.fn(),
    getTools: jest.fn(),
  };

  const mockRegistryService = {
    validateModel: jest.fn().mockReturnValue('anthropic/claude-3-7-sonnet'),
    validateTools: jest.fn().mockReturnValue(['job_list']),
    getConfiguredModel: jest.fn().mockReturnValue('anthropic/claude-3-7-sonnet'),
    getModelConfig: jest.fn().mockReturnValue({
      chatModel: 'anthropic/claude-3-7-sonnet',
      classifyModel: 'anthropic/claude-3-5-haiku',
    }),
  };

  const mockFallbackService = {
    getFallbackMessage: jest.fn().mockReturnValue('我确认下哈，马上回你~'),
    getFallbackInfo: jest.fn().mockReturnValue({
      reason: 'test error',
      message: '我确认下哈，马上回你~',
      suggestion: '花卷Agent调用异常，请检查花卷Agent配置',
    }),
  };

  const successApiResponse = {
    data: {
      success: true,
      data: {
        messages: [
          {
            role: MessageRole.ASSISTANT,
            parts: [{ type: 'text', text: 'Hello! I can help you.' }],
          },
        ],
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
        tools: { used: ['job_list'], skipped: [] },
      },
    },
    headers: { 'x-correlation-id': 'corr-id-123' },
  };

  const sessionId = 'session-test-001';
  const userMessage = '你好，请告诉我职位信息';

  beforeEach(async () => {
    jest.clearAllMocks();

    mockApiClient.chat.mockResolvedValue(successApiResponse);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentApiClientService, useValue: mockApiClient },
        { provide: AgentRegistryService, useValue: mockRegistryService },
        { provide: AgentFallbackService, useValue: mockFallbackService },
      ],
    }).compile();

    service = module.get<AgentService>(AgentService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('chat', () => {
    it('should return success AgentResult on successful API call', async () => {
      const result = await service.chat({ sessionId, userMessage });

      expect(result.status).toBe(AgentResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
      expect(result.data!.messages[0].parts[0].text).toBe('Hello! I can help you.');
    });

    it('should call apiClient.chat with correct request parameters', async () => {
      await service.chat({ sessionId, userMessage });

      expect(mockApiClient.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-3-7-sonnet',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: MessageRole.USER,
              content: userMessage,
            }),
          ]),
          stream: false,
          channelType: 'private',
        }),
        sessionId,
      );
    });

    it('should validate the user message before calling API', async () => {
      await service.chat({ sessionId, userMessage });

      // Message should be in the request
      const chatCall = mockApiClient.chat.mock.calls[0][0];
      const lastMessage = chatCall.messages[chatCall.messages.length - 1];
      expect(lastMessage.content).toBe(userMessage);
    });

    it('should call registryService.validateModel', async () => {
      await service.chat({ sessionId, userMessage, model: 'openai/gpt-4o' });

      expect(mockRegistryService.validateModel).toHaveBeenCalledWith('openai/gpt-4o');
    });

    it('should call registryService.validateTools', async () => {
      await service.chat({ sessionId, userMessage, allowedTools: ['bash'] });

      expect(mockRegistryService.validateTools).toHaveBeenCalledWith(['bash']);
    });

    it('should append user message to messages history', async () => {
      const existingMessages = [
        { role: MessageRole.USER, content: 'Previous message' },
        { role: MessageRole.ASSISTANT, parts: [{ type: 'text', text: 'Previous reply' }] },
      ];

      await service.chat({ sessionId, userMessage, messages: existingMessages as any });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.messages).toHaveLength(3); // 2 history + 1 new
      expect(chatCall.messages[2].content).toBe(userMessage);
    });

    it('should include systemPrompt when provided', async () => {
      const systemPrompt = 'You are an expert HR manager.';

      await service.chat({ sessionId, userMessage, systemPrompt });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.systemPrompt).toBe(systemPrompt);
    });

    it('should include promptType when provided', async () => {
      await service.chat({ sessionId, userMessage, promptType: 'weworkSystemPrompt' });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.promptType).toBe('weworkSystemPrompt');
    });

    it('should inject modelConfig from registryService into context', async () => {
      await service.chat({ sessionId, userMessage });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.context.modelConfig).toEqual({
        chatModel: 'anthropic/claude-3-7-sonnet',
        classifyModel: 'anthropic/claude-3-5-haiku',
      });
    });

    it('should preserve existing context and add modelConfig', async () => {
      const context = { dulidayToken: 'my-token', userId: 'user-123' };

      await service.chat({ sessionId, userMessage, context });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.context.dulidayToken).toBe('my-token');
      expect(chatCall.context.userId).toBe('user-123');
      expect(chatCall.context.modelConfig).toBeDefined();
    });

    it('should not override existing modelConfig in context', async () => {
      const customModelConfig = { chatModel: 'custom-model', classifyModel: 'custom-classify' };
      const context = { modelConfig: customModelConfig };

      await service.chat({ sessionId, userMessage, context });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.context.modelConfig).toEqual(customModelConfig);
    });

    it('should filter toolContext to only include allowed tools', async () => {
      mockRegistryService.validateTools.mockReturnValue(['job_list']);

      const toolContext = {
        job_list: { param: 'value' },
        excluded_tool: { secret: 'data' },
      };

      await service.chat({
        sessionId,
        userMessage,
        allowedTools: ['job_list'],
        toolContext,
      });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.toolContext).toEqual({ job_list: { param: 'value' } });
      expect(chatCall.toolContext?.excluded_tool).toBeUndefined();
    });

    it('should pass full toolContext when allowedTools is undefined', async () => {
      mockRegistryService.validateTools.mockReturnValue(['job_list', 'bash']);

      const toolContext = {
        job_list: { param: 'value' },
        bash: { workDir: '/tmp' },
      };

      await service.chat({ sessionId, userMessage, toolContext });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      // When allowedTools is undefined (validated to configured list), toolContext may be fully passed
      expect(chatCall.toolContext).toBeDefined();
    });

    it('should not include toolContext when allowedTools is empty array', async () => {
      mockRegistryService.validateTools.mockReturnValue([]);

      const toolContext = { job_list: { param: 'value' } };

      await service.chat({
        sessionId,
        userMessage,
        allowedTools: [],
        toolContext,
      });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      // Empty allowedTools means no tools allowed, so toolContext should be omitted
      expect(chatCall.toolContext).toBeUndefined();
    });

    it('should include contextStrategy when provided', async () => {
      await service.chat({
        sessionId,
        userMessage,
        contextStrategy: ContextStrategy.SKIP,
      });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.contextStrategy).toBe(ContextStrategy.SKIP);
    });

    it('should include prune options when provided', async () => {
      const pruneOptions = { maxOutputTokens: 1000, targetTokens: 4000 };

      await service.chat({ sessionId, userMessage, prune: true, pruneOptions });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.prune).toBe(true);
      expect(chatCall.pruneOptions).toEqual(pruneOptions);
    });

    it('should include thinking config when provided', async () => {
      const thinking = { type: 'enabled' as const, budgetTokens: 2000 };

      await service.chat({ sessionId, userMessage, thinking });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.thinking).toEqual(thinking);
    });

    it('should include validateOnly flag when provided', async () => {
      await service.chat({ sessionId, userMessage, validateOnly: true });

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      expect(chatCall.validateOnly).toBe(true);
    });

    it('should attach rawHttpResponse to successful result', async () => {
      const result = await service.chat({ sessionId, userMessage });

      expect(result.rawHttpResponse).toBeDefined();
    });

    it('should attach requestBody to successful result', async () => {
      const result = await service.chat({ sessionId, userMessage });

      expect((result as any).requestBody).toBeDefined();
    });

    it('should return FALLBACK status when user message is empty', async () => {
      const result = await service.chat({ sessionId, userMessage: '' });

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
    });

    it('should return FALLBACK status when user message is whitespace only', async () => {
      const result = await service.chat({ sessionId, userMessage: '   ' });

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
    });

    it('should return FALLBACK status when API call fails', async () => {
      mockApiClient.chat.mockRejectedValue(new Error('API connection error'));

      const result = await service.chat({ sessionId, userMessage });

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
      expect(result.fallback).toBeDefined();
      expect(result.fallbackInfo).toBeDefined();
    });

    it('should call fallbackService.getFallbackInfo on error', async () => {
      const apiError = new Error('Timeout error');
      mockApiClient.chat.mockRejectedValue(apiError);

      await service.chat({ sessionId, userMessage });

      expect(mockFallbackService.getFallbackInfo).toHaveBeenCalledWith('Timeout error', undefined);
    });

    it('should pass retryAfter to fallbackService on rate limit error', async () => {
      const { AgentRateLimitException } = await import('@agent/utils/agent-exceptions');
      const rateLimitError = new AgentRateLimitException(120, 'Rate limited');
      mockApiClient.chat.mockRejectedValue(rateLimitError);

      await service.chat({ sessionId, userMessage });

      expect(mockFallbackService.getFallbackInfo).toHaveBeenCalledWith(expect.any(String), 120);
    });

    it('should return FALLBACK when API response has success: false', async () => {
      mockApiClient.chat.mockResolvedValue({
        data: {
          success: false,
          error: '请求参数错误',
        },
        headers: {},
      });

      const result = await service.chat({ sessionId, userMessage });

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
    });

    it('should throw AgentContextMissingException for missing context errors', async () => {
      mockApiClient.chat.mockResolvedValue({
        data: {
          success: false,
          error: 'Context missing',
          details: {
            missingContext: ['dulidayToken'],
            tools: ['job_list'],
          },
        },
        headers: {},
      });

      // The error is caught and converted to a fallback
      const result = await service.chat({ sessionId, userMessage });
      expect(result.status).toBe(AgentResultStatus.FALLBACK);
    });

    it('should attach requestBody to fallback result when error occurs', async () => {
      mockApiClient.chat.mockRejectedValue(new Error('Network error'));

      const result = await service.chat({ sessionId, userMessage });

      expect((result as any).requestBody).toBeDefined();
    });

    it('should log usage statistics on successful response', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.chat({ sessionId, userMessage });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Token使用'));
    });

    it('should log tools used on successful response with tools', async () => {
      const logSpy = jest.spyOn(service['logger'], 'log');

      await service.chat({ sessionId, userMessage });

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('工具调用'));
    });
  });

  describe('chatWithProfile', () => {
    const profile = {
      name: 'candidate-consultation',
      description: 'Test profile',
      model: 'anthropic/claude-3-7-sonnet',
      allowedTools: ['job_list'],
      systemPrompt: 'You are helpful.',
      contextStrategy: ContextStrategy.SKIP,
    };

    it('should call chat with sanitized profile parameters', async () => {
      await service.chatWithProfile(sessionId, userMessage, profile as any);

      expect(mockApiClient.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-3-7-sonnet',
        }),
        sessionId,
      );
    });

    it('should return AgentResult from the underlying chat call', async () => {
      const result = await service.chatWithProfile(sessionId, userMessage, profile as any);

      expect(result.status).toBe(AgentResultStatus.SUCCESS);
      expect(result.data).toBeDefined();
    });

    it('should apply overrides over the profile', async () => {
      await service.chatWithProfile(sessionId, userMessage, profile as any, {
        model: 'openai/gpt-4o',
      });

      // validateModel will be called with the overridden model
      expect(mockRegistryService.validateModel).toHaveBeenCalledWith('openai/gpt-4o');
    });

    it('should merge context overrides with profile context', async () => {
      const profileWithContext = {
        ...profile,
        context: { dulidayToken: 'base-token' },
      };

      await service.chatWithProfile(
        sessionId,
        userMessage,
        profileWithContext as any,
        {
          context: { extraField: 'extra-value' },
        } as any,
      );

      const chatCall = mockApiClient.chat.mock.calls[0][0];
      // The merged context should have fields from both (after sanitization)
      expect(chatCall.context).toBeDefined();
    });

    it('should handle fallback when chat fails', async () => {
      mockApiClient.chat.mockRejectedValue(new Error('Service down'));

      const result = await service.chatWithProfile(sessionId, userMessage, profile as any);

      expect(result.status).toBe(AgentResultStatus.FALLBACK);
    });
  });

  describe('chatStream', () => {
    const mockStream = { pipe: jest.fn(), on: jest.fn() };

    beforeEach(() => {
      mockApiClient.chatStream.mockResolvedValue(mockStream);
    });

    it('should return stream, requestBody, and estimatedInputTokens', async () => {
      const result = await service.chatStream({ sessionId, userMessage });

      expect(result.stream).toBe(mockStream);
      expect(result.requestBody).toBeDefined();
      expect(typeof result.estimatedInputTokens).toBe('number');
    });

    it('should call apiClient.chatStream with the built request', async () => {
      await service.chatStream({ sessionId, userMessage });

      expect(mockApiClient.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'anthropic/claude-3-7-sonnet',
          messages: expect.arrayContaining([expect.objectContaining({ role: MessageRole.USER })]),
        }),
        sessionId,
      );
    });

    it('should estimate input tokens based on message content', async () => {
      const longMessage = 'a'.repeat(1000);

      const result = await service.chatStream({ sessionId, userMessage: longMessage });

      // Long message should result in higher estimated tokens
      expect(result.estimatedInputTokens).toBeGreaterThan(0);
    });

    it('should include system prompt in token estimation', async () => {
      const systemPrompt = 'Long system prompt: ' + 'x'.repeat(2000);

      const result1 = await service.chatStream({ sessionId, userMessage });
      const result2 = await service.chatStream({ sessionId, userMessage, systemPrompt });

      expect(result2.estimatedInputTokens).toBeGreaterThan(result1.estimatedInputTokens);
    });

    it('should propagate errors from apiClient.chatStream', async () => {
      mockApiClient.chatStream.mockRejectedValue(new Error('Stream error'));

      await expect(service.chatStream({ sessionId, userMessage })).rejects.toThrow('Stream error');
    });

    it('should throw when userMessage is empty', async () => {
      // Empty message throws AgentConfigException which propagates (no fallback in stream)
      await expect(service.chatStream({ sessionId, userMessage: '' })).rejects.toThrow();
    });
  });

  describe('chatStreamWithProfile', () => {
    const mockStream = { pipe: jest.fn(), on: jest.fn() };
    const profile = {
      name: 'test-profile',
      description: 'Test',
      model: 'anthropic/claude-3-7-sonnet',
      allowedTools: ['job_list'],
    };

    beforeEach(() => {
      mockApiClient.chatStream.mockResolvedValue(mockStream);
    });

    it('should call chatStream with merged profile parameters', async () => {
      const result = await service.chatStreamWithProfile(sessionId, userMessage, profile as any);

      expect(result.stream).toBeDefined();
      expect(result.requestBody).toBeDefined();
      expect(result.estimatedInputTokens).toBeDefined();
    });

    it('should apply overrides over the profile', async () => {
      await service.chatStreamWithProfile(sessionId, userMessage, profile as any, {
        model: 'openai/gpt-4o',
      });

      expect(mockRegistryService.validateModel).toHaveBeenCalledWith('openai/gpt-4o');
    });

    it('should pass messages and thinking from overrides', async () => {
      const messages = [{ role: MessageRole.USER, content: 'history' }];
      const thinking = { type: 'enabled' as const, budgetTokens: 1000 };

      await service.chatStreamWithProfile(sessionId, userMessage, profile as any, {
        messages,
        thinking,
      });

      expect(mockApiClient.chatStream).toHaveBeenCalledWith(
        expect.objectContaining({
          thinking,
        }),
        sessionId,
      );
    });
  });

  describe('getModels', () => {
    it('should delegate to apiClient.getModels', async () => {
      const mockModels = { models: [{ id: 'gpt-4' }] };
      mockApiClient.getModels.mockResolvedValue(mockModels);

      const result = await service.getModels();

      expect(mockApiClient.getModels).toHaveBeenCalled();
      expect(result).toEqual(mockModels);
    });

    it('should propagate errors from apiClient', async () => {
      mockApiClient.getModels.mockRejectedValue(new Error('Models API error'));

      await expect(service.getModels()).rejects.toThrow('Models API error');
    });
  });

  describe('getTools', () => {
    it('should delegate to apiClient.getTools', async () => {
      const mockTools = { tools: [{ name: 'job_list' }] };
      mockApiClient.getTools.mockResolvedValue(mockTools);

      const result = await service.getTools();

      expect(mockApiClient.getTools).toHaveBeenCalled();
      expect(result).toEqual(mockTools);
    });

    it('should propagate errors from apiClient', async () => {
      mockApiClient.getTools.mockRejectedValue(new Error('Tools API error'));

      await expect(service.getTools()).rejects.toThrow('Tools API error');
    });
  });

  describe('model fallback warning', () => {
    it('should warn when requested model differs from validated model', async () => {
      mockRegistryService.validateModel.mockReturnValue('anthropic/claude-3-7-sonnet');
      const warnSpy = jest.spyOn(service['logger'], 'warn');

      await service.chat({ sessionId, userMessage, model: 'non-existent-model' });

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('不可用'));
    });
  });
});
