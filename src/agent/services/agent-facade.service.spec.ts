import { Test, TestingModule } from '@nestjs/testing';
import { HttpException, HttpStatus } from '@nestjs/common';
import { AgentFacadeService } from './agent-facade.service';
import { AgentService } from '../agent.service';
import { ProfileLoaderService } from './agent-profile-loader.service';
import { StrategyConfigService } from '../strategy/strategy-config.service';
import { AgentConfigValidator } from '../utils/agent-validator';
import { AgentResultStatus } from '../utils/agent-enums';
import { AgentProfile } from '../utils/agent-types';
import { MessageRole } from '@shared/enums';

describe('AgentFacadeService', () => {
  let service: AgentFacadeService;

  const mockAgentService = {
    chat: jest.fn(),
    chatStreamWithProfile: jest.fn(),
  };

  const mockProfileLoader = {
    getProfile: jest.fn(),
  };

  const mockStrategyConfigService = {
    composeSystemPromptAndStageGoals: jest.fn(),
  };

  const mockConfigValidator = {
    validateRequiredFields: jest.fn(),
    validateContext: jest.fn(),
  };

  const baseProfile: AgentProfile = {
    name: 'candidate-consultation',
    description: 'Candidate consultation service',
    model: 'anthropic/claude-3-7-sonnet',
    promptType: 'weworkSystemPrompt',
    allowedTools: ['job_list'],
    systemPrompt: 'You are a helpful HR assistant. {{CURRENT_TIME}}',
    context: {
      dulidayToken: 'test-token',
    },
    toolContext: {
      wework_plan_turn: { stageGoals: {} },
    },
  };

  const mockChatResult = {
    status: AgentResultStatus.SUCCESS,
    data: {
      messages: [{ role: 'assistant', parts: [{ type: 'text', text: 'Hello!' }] }],
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      tools: { used: [], skipped: [] },
    },
  };

  const mockStageGoals = {
    initial: { stage: 'initial', goal: 'Build rapport' },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockProfileLoader.getProfile.mockReturnValue(baseProfile);
    mockConfigValidator.validateRequiredFields.mockReturnValue(undefined);
    mockConfigValidator.validateContext.mockReturnValue({ isValid: true, errors: [] });
    mockStrategyConfigService.composeSystemPromptAndStageGoals.mockResolvedValue({
      systemPrompt: 'Composed system prompt',
      stageGoals: mockStageGoals,
    });
    mockAgentService.chat.mockResolvedValue(mockChatResult);
    mockAgentService.chatStreamWithProfile.mockResolvedValue({
      stream: { pipe: jest.fn() },
      requestBody: {},
      estimatedInputTokens: 100,
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentFacadeService,
        { provide: AgentService, useValue: mockAgentService },
        { provide: ProfileLoaderService, useValue: mockProfileLoader },
        { provide: StrategyConfigService, useValue: mockStrategyConfigService },
        { provide: AgentConfigValidator, useValue: mockConfigValidator },
      ],
    }).compile();

    service = module.get<AgentFacadeService>(AgentFacadeService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('chatWithScenario', () => {
    const scenario = 'candidate-consultation';
    const sessionId = 'test-session-123';
    const userMessage = '你好，我想了解这个职位';
    const userId = 'user-456';

    it('should call agentService.chat with prepared parameters', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      expect(mockAgentService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          userMessage,
          model: baseProfile.model,
          allowedTools: baseProfile.allowedTools,
        }),
      );
    });

    it('should return the agent result from chat', async () => {
      const result = await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      expect(result).toEqual(mockChatResult);
    });

    it('should throw HttpException when profile is not found', async () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, { userId }),
      ).rejects.toThrow(HttpException);

      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, { userId }),
      ).rejects.toMatchObject({
        status: HttpStatus.NOT_FOUND,
      });
    });

    it('should throw HttpException with NOT_FOUND when profile missing', async () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      try {
        await service.chatWithScenario('non-existent-scenario', sessionId, userMessage, { userId });
        fail('Should have thrown');
      } catch (e: any) {
        expect(e).toBeInstanceOf(HttpException);
        expect(e.getStatus()).toBe(HttpStatus.NOT_FOUND);
        expect(e.message).toContain('non-existent-scenario');
      }
    });

    it('should throw HttpException when userId is missing', async () => {
      await expect(service.chatWithScenario(scenario, sessionId, userMessage, {})).rejects.toThrow(
        HttpException,
      );

      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, {}),
      ).rejects.toMatchObject({
        status: HttpStatus.BAD_REQUEST,
      });
    });

    it('should throw HttpException when options is undefined (missing userId)', async () => {
      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, undefined),
      ).rejects.toThrow(HttpException);
    });

    it('should merge extraContext into the request context', async () => {
      const extraContext = { additionalField: 'extra-value' };

      await service.chatWithScenario(scenario, sessionId, userMessage, {
        userId,
        extraContext,
      });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.context).toMatchObject({
        additionalField: 'extra-value',
        dulidayToken: 'test-token',
        userId,
        sessionId,
      });
    });

    it('should inject userId and sessionId into context', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.context).toMatchObject({
        userId,
        sessionId,
      });
    });

    it('should inject strategy system prompt when compose succeeds', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.systemPrompt).toContain('Composed system prompt');
    });

    it('should inject stageGoals into toolContext for wework_plan_turn', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.toolContext?.wework_plan_turn?.stageGoals).toEqual(mockStageGoals);
    });

    it('should use base systemPrompt when strategy compose fails', async () => {
      mockStrategyConfigService.composeSystemPromptAndStageGoals.mockRejectedValue(
        new Error('Strategy service error'),
      );

      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      // Should still call chat (fallback to base config)
      expect(mockAgentService.chat).toHaveBeenCalled();
    });

    it('should override model when provided in options', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, {
        userId,
        model: 'openai/gpt-4o',
      });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.model).toBe('openai/gpt-4o');
    });

    it('should override allowedTools when provided in options', async () => {
      await service.chatWithScenario(scenario, sessionId, userMessage, {
        userId,
        allowedTools: ['bash'],
      });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.allowedTools).toEqual(['bash']);
    });

    it('should pass messages to agentService.chat', async () => {
      const messages = [{ role: MessageRole.USER, content: 'Previous message' }];

      await service.chatWithScenario(scenario, sessionId, userMessage, {
        userId,
        messages,
      });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.messages).toEqual(messages);
    });

    it('should replace {{CURRENT_TIME}} placeholder in system prompt', async () => {
      // Strategy service returns a prompt that still has the placeholder replaced
      mockStrategyConfigService.composeSystemPromptAndStageGoals.mockResolvedValue({
        systemPrompt: 'Prompt with time injected',
        stageGoals: {},
      });

      await service.chatWithScenario(scenario, sessionId, userMessage, { userId });

      const chatCall = mockAgentService.chat.mock.calls[0][0];
      expect(chatCall.systemPrompt).not.toContain('{{CURRENT_TIME}}');
    });

    it('should throw HttpException when profile context validation fails', async () => {
      mockConfigValidator.validateContext.mockReturnValue({
        isValid: false,
        errors: ['context.modelConfig must be an object'],
      });

      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, { userId }),
      ).rejects.toThrow(HttpException);
    });

    it('should throw when validateRequiredFields throws', async () => {
      mockConfigValidator.validateRequiredFields.mockImplementation(() => {
        throw new Error('model is required');
      });

      await expect(
        service.chatWithScenario(scenario, sessionId, userMessage, { userId }),
      ).rejects.toThrow('model is required');
    });
  });

  describe('chatStreamWithScenario', () => {
    const scenario = 'candidate-consultation';
    const sessionId = 'stream-session-123';
    const userMessage = 'Stream this message';
    const userId = 'user-789';

    it('should call agentService.chatStreamWithProfile with prepared parameters', async () => {
      const result = await service.chatStreamWithScenario(scenario, sessionId, userMessage, {
        userId,
      });

      expect(mockAgentService.chatStreamWithProfile).toHaveBeenCalledWith(
        sessionId,
        userMessage,
        baseProfile,
        expect.objectContaining({
          model: baseProfile.model,
        }),
      );

      expect(result.scenario).toBe(scenario);
      expect(result.profileName).toBe(baseProfile.name);
      expect(result.sessionId).toBe(sessionId);
    });

    it('should return StreamChatResult with stream and metadata', async () => {
      const mockStream = { pipe: jest.fn(), on: jest.fn() };
      mockAgentService.chatStreamWithProfile.mockResolvedValue({
        stream: mockStream,
        requestBody: {},
        estimatedInputTokens: 250,
      });

      const result = await service.chatStreamWithScenario(scenario, sessionId, userMessage, {
        userId,
      });

      expect(result.stream).toBe(mockStream);
      expect(result.estimatedInputTokens).toBe(250);
      expect(result.scenario).toBe(scenario);
      expect(result.profileName).toBe('candidate-consultation');
      expect(result.sessionId).toBe(sessionId);
    });

    it('should throw HttpException when profile is not found', async () => {
      mockProfileLoader.getProfile.mockReturnValue(null);

      await expect(
        service.chatStreamWithScenario(scenario, sessionId, userMessage, { userId }),
      ).rejects.toThrow(HttpException);
    });

    it('should throw HttpException when userId is missing', async () => {
      await expect(
        service.chatStreamWithScenario(scenario, sessionId, userMessage, {}),
      ).rejects.toThrow(HttpException);
    });

    it('should pass thinking options to chatStreamWithProfile', async () => {
      const thinking = { type: 'enabled' as const, budgetTokens: 1000 };

      await service.chatStreamWithScenario(scenario, sessionId, userMessage, {
        userId,
        thinking,
      });

      const callArgs = mockAgentService.chatStreamWithProfile.mock.calls[0][3];
      expect(callArgs.thinking).toEqual(thinking);
    });

    it('should fallback gracefully when strategy compose fails during stream', async () => {
      mockStrategyConfigService.composeSystemPromptAndStageGoals.mockRejectedValue(
        new Error('Strategy unavailable'),
      );

      const result = await service.chatStreamWithScenario(scenario, sessionId, userMessage, {
        userId,
      });

      expect(result).toBeDefined();
      expect(mockAgentService.chatStreamWithProfile).toHaveBeenCalled();
    });
  });
});
