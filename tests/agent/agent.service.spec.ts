import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentRunnerService } from '@agent/runner.service';
import { AgentPreparationService } from '@agent/agent-preparation.service';
import { MemoryService } from '@memory/memory.service';
import { ReliableService } from '@providers/reliable.service';

// Mock generateText from ai SDK
jest.mock('ai', () => ({
  generateText: jest.fn().mockResolvedValue({
    text: 'Hello!',
    steps: [{}],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }),
  streamText: jest.fn(),
  stepCountIs: jest.fn().mockReturnValue(() => false),
  hasToolCall: jest.fn().mockReturnValue(() => false),
}));

/**
 * AgentRunnerService.invoke() 测试
 *
 * 测试 invoke() 的完整流水线：stage → compose → classify → 记忆 → generateText
 */
describe('AgentRunnerService - invoke', () => {
  let service: AgentRunnerService;

  const mockPreparation = {
    prepare: jest.fn().mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      chatModelId: 'mock-model-id',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    }),
  };

  const mockMemoryService = {
    onTurnEnd: jest.fn().mockResolvedValue(undefined),
  };

  const mockReliableService = {
    generateText: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => defaultValue),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: AgentPreparationService, useValue: mockPreparation },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: ReliableService, useValue: mockReliableService },
      ],
    }).compile();

    service = module.get<AgentRunnerService>(AgentRunnerService);
    jest.clearAllMocks();

    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      chatModelId: 'mock-model-id',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    });
    mockMemoryService.onTurnEnd.mockResolvedValue(undefined);
    mockReliableService.generateText.mockResolvedValue({
      text: 'Hello!',
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    // Re-mock streamText for each test
    const { streamText } = require('ai');
    streamText.mockReset();
  });

  const invokeParams = {
    messages: [{ role: 'user', content: 'Hello' }],
    userId: 'user-123',
    corpId: 'corp-1',
    sessionId: 'sess-1',
  };

  it('should prepare, execute, and finish turn lifecycle', async () => {
    const result = await service.invoke(invokeParams);

    expect(result.text).toBe('Hello!');
    expect(result.steps).toBe(1);
    expect(mockPreparation.prepare).toHaveBeenCalledWith(invokeParams, 'invoke');
  });

  it('should expose actual llm request snapshot', async () => {
    const onPreparedRequest = jest.fn();

    const result = await service.invoke({ ...invokeParams, onPreparedRequest });

    expect(onPreparedRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        modelId: 'mock-model-id',
        system: 'test system prompt',
        messages: [{ role: 'user', content: 'Hello' }],
        fallbackModelIds: ['mock-fallback-model'],
        maxOutputTokens: 4096,
        maxSteps: 5,
      }),
    );
    expect(result.agentRequest).toEqual(
      expect.objectContaining({
        modelId: 'mock-model-id',
        system: 'test system prompt',
        messages: [{ role: 'user', content: 'Hello' }],
        fallbackModelIds: ['mock-fallback-model'],
        maxOutputTokens: 4096,
        maxSteps: 5,
      }),
    );
  });

  it('should expose response messages from generateText for downstream observability', async () => {
    mockReliableService.generateText.mockResolvedValueOnce({
      text: 'Hello!',
      response: {
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: '先思考一下' },
              { type: 'text', text: 'Hello!' },
            ],
          },
        ],
      },
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    const result = await service.invoke(invokeParams);

    expect(result.responseMessages).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先思考一下' },
          { type: 'text', text: 'Hello!' },
        ],
      },
    ]);
  });

  it('should map deep thinking to provider-specific options for invoke', async () => {
    mockPreparation.prepare.mockResolvedValueOnce({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      chatModelId: 'openai/gpt-5.1',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    });

    await service.invoke({
      ...invokeParams,
      thinking: {
        type: 'enabled',
        budgetTokens: 4000,
      },
    });

    expect(mockReliableService.generateText).toHaveBeenCalledWith(
      'openai/gpt-5.1',
      expect.objectContaining({
        providerOptions: {
          openai: {
            reasoningEffort: 'high',
          },
        },
      }),
      ['mock-fallback-model'],
    );
  });

  it('should honor explicit fast mode and disable deep thinking overrides', async () => {
    mockPreparation.prepare.mockResolvedValueOnce({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      chatModelId: 'deepseek/deepseek-chat',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    });

    await service.invoke({
      ...invokeParams,
      thinking: {
        type: 'disabled',
        budgetTokens: 0,
      },
    });

    expect(mockReliableService.generateText).toHaveBeenCalledWith(
      'deepseek/deepseek-chat',
      expect.objectContaining({
        providerOptions: {
          deepseek: {
            thinking: {
              type: 'disabled',
            },
          },
        },
      }),
      ['mock-fallback-model'],
    );
  });

  it('should pass persisted stage to compose', async () => {
    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      chatModelId: 'mock-model-id',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: 'job_consultation',
      turnState: { candidatePool: null },
    });

    await service.invoke(invokeParams);

    expect(mockPreparation.prepare).toHaveBeenCalledWith(invokeParams, 'invoke');
  });

  it('should pass undefined stage when no stage in memory', async () => {
    await service.invoke(invokeParams);

    expect(mockPreparation.prepare).toHaveBeenCalledWith(invokeParams, 'invoke');
  });

  it('should use default scenario when none provided', async () => {
    await service.invoke(invokeParams);

    expect(mockPreparation.prepare).toHaveBeenCalledWith(invokeParams, 'invoke');
  });

  it('should use custom scenario when provided', async () => {
    await service.invoke({ ...invokeParams, scenario: 'group-operations' });

    expect(mockPreparation.prepare).toHaveBeenCalledWith(
      { ...invokeParams, scenario: 'group-operations' },
      'invoke',
    );
  });

  it('should rethrow error when generateText throws', async () => {
    mockReliableService.generateText.mockRejectedValue(new Error('Network timeout'));

    await expect(service.invoke(invokeParams)).rejects.toThrow('Network timeout');
  });

  it('should enrich thrown model errors with agent metadata', async () => {
    mockReliableService.generateText.mockRejectedValue(new Error('Network timeout'));

    const error = await service.invoke(invokeParams).catch((err) => err);

    expect(error).toMatchObject({
      isAgentError: true,
      agentMeta: expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-123',
        messageCount: 1,
      }),
    });
  });

  it('should include memory warning when messages are empty', async () => {
    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [],
      memoryLoadWarning: 'shortTerm: Connection timeout',
      chatModel: 'mock-model',
      chatModelId: 'mock-model-id',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    });

    const error = await service.invoke(invokeParams).catch((err) => err);

    expect(error.message).toContain('sessionId=sess-1');
    expect(error.message).toContain('memoryWarning=shortTerm: Connection timeout');
    expect(error).toMatchObject({
      isAgentError: true,
      agentMeta: expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-123',
        messageCount: 0,
        memoryLoadWarning: 'shortTerm: Connection timeout',
      }),
    });
  });

  it('should trigger memory lifecycle after assistant turn', async () => {
    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [
        { role: 'assistant', content: '杨浦奥乐齐这边有长白这家店。' },
        { role: 'user', content: '我想报名长白' },
      ],
      chatModel: 'mock-model',
      chatModelId: 'mock-model-id',
      chatFallbacks: ['mock-fallback-model'],
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: [{ jobId: 519709, brandName: '奥乐齐', storeName: '长白' }] },
    });

    mockReliableService.generateText.mockResolvedValue({
      text: '可以，我先帮你确认下长白这边的面试要求。',
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });

    await service.invoke({
      ...invokeParams,
      messages: [
        { role: 'assistant', content: '杨浦奥乐齐这边有长白这家店。' },
        { role: 'user', content: '我想报名长白' },
      ],
    });

    expect(mockMemoryService.onTurnEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        corpId: 'corp-1',
        userId: 'user-123',
        sessionId: 'sess-1',
        candidatePool: [{ jobId: 519709, brandName: '奥乐齐', storeName: '长白' }],
      }),
      '可以，我先帮你确认下长白这边的面试要求。',
    );
  });

  it('should not fail invoke when turn-end lifecycle fails', async () => {
    mockMemoryService.onTurnEnd.mockRejectedValue(new Error('memory lifecycle failed'));

    await expect(service.invoke(invokeParams)).resolves.toEqual(
      expect.objectContaining({
        text: 'Hello!',
        steps: 1,
      }),
    );
  });

  it('should enrich stream setup failures with agent metadata', async () => {
    const { streamText } = require('ai');
    streamText.mockImplementation(() => {
      throw new Error('stream init failed');
    });

    const error = await service.stream(invokeParams).catch((err) => err);

    expect(error).toMatchObject({
      message: 'stream init failed',
      isAgentError: true,
      agentMeta: expect.objectContaining({
        sessionId: 'sess-1',
        userId: 'user-123',
        messageCount: 1,
      }),
    });
  });
});
