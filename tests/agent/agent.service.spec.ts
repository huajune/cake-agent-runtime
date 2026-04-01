import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentRunnerService } from '@agent/runner.service';
import { AgentPreparationService } from '@agent/agent-preparation.service';
import { MemoryService } from '@memory/memory.service';

// Mock generateText from ai SDK
jest.mock('ai', () => ({
  generateText: jest.fn().mockResolvedValue({
    text: 'Hello!',
    steps: [{}],
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
  }),
  streamText: jest.fn(),
  stepCountIs: jest.fn().mockReturnValue(() => false),
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
      ],
    }).compile();

    service = module.get<AgentRunnerService>(AgentRunnerService);
    jest.clearAllMocks();

    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: null },
    });
    mockMemoryService.onTurnEnd.mockResolvedValue(undefined);

    // Re-mock generateText for each test
    const { generateText } = require('ai');
    generateText.mockResolvedValue({
      text: 'Hello!',
      steps: [{}],
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    });
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

  it('should pass persisted stage to compose', async () => {
    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [{ role: 'user', content: 'Hello' }],
      chatModel: 'mock-model',
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
    const { generateText } = require('ai');
    generateText.mockRejectedValue(new Error('Network timeout'));

    await expect(service.invoke(invokeParams)).rejects.toThrow('Network timeout');
  });

  it('should trigger memory lifecycle after assistant turn', async () => {
    mockPreparation.prepare.mockResolvedValue({
      finalPrompt: 'test system prompt',
      typedMessages: [
        { role: 'assistant', content: '杨浦奥乐齐这边有长白这家店。' },
        { role: 'user', content: '我想报名长白' },
      ],
      chatModel: 'mock-model',
      tools: {},
      corpId: 'corp-1',
      userId: 'user-123',
      sessionId: 'sess-1',
      maxSteps: 5,
      entryStage: null,
      turnState: { candidatePool: [{ jobId: 519709, brandName: '奥乐齐', storeName: '长白' }] },
    });

    const { generateText } = require('ai');
    generateText.mockResolvedValue({
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
});
