import { Test, TestingModule } from '@nestjs/testing';
import { LoopService } from '@agent/loop.service';
import { ContextService } from '@agent/context/context.service';
import { SignalDetectorService } from '@agent/signal-detector.service';
import { FactExtractionService } from '@agent/fact-extraction.service';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
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
 * LoopService.invoke() 测试
 *
 * 测试 invoke() 的完整流水线：stage → compose → classify → 记忆 → generateText
 */
describe('LoopService - invoke', () => {
  let service: LoopService;

  const mockContext = {
    compose: jest.fn().mockResolvedValue({
      systemPrompt: 'test system prompt',
    }),
  };

  const mockClassifier = {
    detect: jest.fn().mockReturnValue({ needs: ['none'], riskFlags: [] }),
    formatDetectionBlock: jest.fn().mockReturnValue(''),
  };

  const mockMemoryService = {
    recall: jest.fn().mockResolvedValue(null),
    store: jest.fn().mockResolvedValue(undefined),
    getSessionState: jest.fn().mockResolvedValue(null),
    formatSessionMemoryForPrompt: jest.fn().mockReturnValue(''),
  };

  const mockRouter = {
    resolveByRole: jest.fn().mockReturnValue('mock-model'),
  };

  const mockToolRegistry = {
    buildAll: jest.fn().mockReturnValue({}),
    buildForScenario: jest.fn().mockReturnValue({}),
  };

  const mockFactExtraction = {
    extractAndSave: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        LoopService,
        { provide: ContextService, useValue: mockContext },
        { provide: SignalDetectorService, useValue: mockClassifier },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: RouterService, useValue: mockRouter },
        { provide: ToolRegistryService, useValue: mockToolRegistry },
        { provide: FactExtractionService, useValue: mockFactExtraction },
      ],
    }).compile();

    service = module.get<LoopService>(LoopService);
    jest.clearAllMocks();

    mockContext.compose.mockResolvedValue({ systemPrompt: 'test system prompt' });
    mockClassifier.detect.mockReturnValue({ needs: ['none'], riskFlags: [] });
    mockClassifier.formatDetectionBlock.mockReturnValue('');
    mockMemoryService.recall.mockResolvedValue(null);
    mockRouter.resolveByRole.mockReturnValue('mock-model');

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

  it('should read stage, compose, classify, and execute', async () => {
    const result = await service.invoke(invokeParams);

    expect(result.text).toBe('Hello!');
    expect(result.steps).toBe(1);
    expect(mockMemoryService.recall).toHaveBeenCalledWith('stage:corp-1:user-123:sess-1');
    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'candidate-consultation', currentStage: undefined }),
    );
    expect(mockClassifier.detect).toHaveBeenCalledWith(invokeParams.messages);
  });

  it('should pass persisted stage to compose', async () => {
    mockMemoryService.recall.mockResolvedValue({
      content: { currentStage: 'job_consultation' },
      updatedAt: new Date().toISOString(),
    });

    await service.invoke(invokeParams);

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ currentStage: 'job_consultation' }),
    );
  });

  it('should pass undefined stage when no stage in memory', async () => {
    mockMemoryService.recall.mockResolvedValue(null);

    await service.invoke(invokeParams);

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ currentStage: undefined }),
    );
  });

  it('should append detection block to prompt when classifier returns results', async () => {
    mockClassifier.formatDetectionBlock.mockReturnValue('[检测到的需求]: salary');

    await service.invoke(invokeParams);

    const { generateText } = require('ai');
    const callArgs = generateText.mock.calls[0][0];
    expect(callArgs.system).toContain('test system prompt');
    expect(callArgs.system).toContain('[检测到的需求]: salary');
  });

  it('should not append detection block when empty', async () => {
    mockClassifier.formatDetectionBlock.mockReturnValue('');

    await service.invoke(invokeParams);

    const { generateText } = require('ai');
    const callArgs = generateText.mock.calls[0][0];
    expect(callArgs.system).not.toContain('[检测到的需求]');
  });

  it('should use default scenario when none provided', async () => {
    await service.invoke(invokeParams);

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'candidate-consultation' }),
    );
  });

  it('should use custom scenario when provided', async () => {
    await service.invoke({ ...invokeParams, scenario: 'group-operations' });

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'group-operations' }),
    );
  });

  it('should rethrow error when generateText throws', async () => {
    const { generateText } = require('ai');
    generateText.mockRejectedValue(new Error('Network timeout'));

    await expect(service.invoke(invokeParams)).rejects.toThrow('Network timeout');
  });
});
