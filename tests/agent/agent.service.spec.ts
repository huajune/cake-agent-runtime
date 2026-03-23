import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AgentRunnerService } from '@agent/runner.service';
import { ContextService } from '@agent/context/context.service';
import { FactExtractionService } from '@agent/fact-extraction.service';
import { InputGuardService } from '@agent/input-guard.service';
import { RouterService } from '@providers/router.service';
import { ToolRegistryService } from '@tools/tool-registry.service';
import { MemoryService } from '@memory/memory.service';
import { MemoryConfig } from '@memory/memory.config';
import { SettlementService } from '@memory/settlement.service';

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

  const mockContext = {
    compose: jest.fn().mockResolvedValue({
      systemPrompt: 'test system prompt',
    }),
  };

  const mockSessionFacts = {
    storeInteraction: jest.fn().mockResolvedValue(undefined),
    formatForPrompt: jest.fn().mockReturnValue(''),
  };

  const mockLongTerm = {
    formatProfileForPrompt: jest.fn().mockReturnValue(''),
  };

  const mockMemoryService = {
    recall: jest.fn().mockResolvedValue(null),
    store: jest.fn().mockResolvedValue(undefined),
    getSessionState: jest.fn().mockResolvedValue(null),
    formatSessionMemoryForPrompt: jest.fn().mockReturnValue(''),
    recallAll: jest.fn().mockResolvedValue({
      shortTerm: [],
      longTerm: { profile: null },
      procedural: { currentStage: null, advancedAt: null, reason: null },
      sessionFacts: null,
    }),
    sessionFacts: mockSessionFacts,
    longTerm: mockLongTerm,
  };

  const mockMemoryConfig = {
    sessionTtl: 86400,
    shortTermMaxMessages: 60,
    shortTermMaxChars: 8000,
    profileCacheTtl: 7200,
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

  const mockInputGuard = {
    detectMessages: jest.fn().mockReturnValue({ safe: true }),
    alertInjection: jest.fn().mockResolvedValue(undefined),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => defaultValue),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AgentRunnerService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: ContextService, useValue: mockContext },
        { provide: MemoryService, useValue: mockMemoryService },
        { provide: MemoryConfig, useValue: mockMemoryConfig },
        { provide: SettlementService, useValue: { checkAndSettle: jest.fn().mockResolvedValue(false) } },
        { provide: RouterService, useValue: mockRouter },
        { provide: ToolRegistryService, useValue: mockToolRegistry },
        { provide: FactExtractionService, useValue: mockFactExtraction },
        { provide: InputGuardService, useValue: mockInputGuard },
      ],
    }).compile();

    service = module.get<AgentRunnerService>(AgentRunnerService);
    jest.clearAllMocks();

    mockContext.compose.mockResolvedValue({ systemPrompt: 'test system prompt' });
    mockMemoryService.recallAll.mockResolvedValue({
      shortTerm: [],
      longTerm: { profile: null },
      procedural: { currentStage: null, advancedAt: null, reason: null },
      sessionFacts: null,
    });
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

  it('should recallAll, compose, classify, and execute', async () => {
    const result = await service.invoke(invokeParams);

    expect(result.text).toBe('Hello!');
    expect(result.steps).toBe(1);
    expect(mockMemoryService.recallAll).toHaveBeenCalledWith('corp-1', 'user-123', 'sess-1');
    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: 'candidate-consultation', currentStage: undefined }),
    );
  });

  it('should pass persisted stage to compose', async () => {
    mockMemoryService.recallAll.mockResolvedValue({
      shortTerm: [],
      longTerm: { profile: null },
      procedural: { currentStage: 'job_consultation', advancedAt: null, reason: null },
      sessionFacts: null,
    });

    await service.invoke(invokeParams);

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ currentStage: 'job_consultation' }),
    );
  });

  it('should pass undefined stage when no stage in memory', async () => {
    mockMemoryService.recallAll.mockResolvedValue({
      shortTerm: [],
      longTerm: { profile: null },
      procedural: { currentStage: null, advancedAt: null, reason: null },
      sessionFacts: null,
    });

    await service.invoke(invokeParams);

    expect(mockContext.compose).toHaveBeenCalledWith(
      expect.objectContaining({ currentStage: undefined }),
    );
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
