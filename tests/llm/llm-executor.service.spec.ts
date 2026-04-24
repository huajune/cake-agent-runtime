import { generateText, Output, streamText } from 'ai';
import { z } from 'zod';
import { LlmExecutorService } from '@/llm/llm-executor.service';
import { RegistryService } from '@providers/registry.service';
import { ReliableService } from '@providers/reliable.service';
import { RouterService } from '@providers/router.service';
import { ModelRole, supportsVision } from '@providers/types';

jest.mock('ai', () => ({
  generateText: jest.fn(),
  streamText: jest.fn(),
  Output: {
    object: jest.fn().mockImplementation((opts: unknown) => opts),
  },
}));

jest.mock('@providers/types', () => {
  const actual = jest.requireActual('@providers/types');
  return {
    ...actual,
    supportsVision: jest.fn(),
  };
});

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;
const mockStreamText = streamText as jest.MockedFunction<typeof streamText>;
const mockOutputObject = Output.object as unknown as jest.MockedFunction<typeof Output.object>;
const mockSupportsVision = supportsVision as jest.MockedFunction<typeof supportsVision>;

type MockRouter = {
  resolveRoute: jest.Mock;
};

type MockRegistry = {
  resolve: jest.Mock;
};

type MockReliable = {
  isModelAvailable: jest.Mock;
  getRetryConfig: jest.Mock;
  classifyError: jest.Mock;
  shouldRetry: jest.Mock;
  getBackoffMs: jest.Mock;
};

describe('LlmExecutorService', () => {
  let service: LlmExecutorService;
  let mockRouter: MockRouter;
  let mockRegistry: MockRegistry;
  let mockReliable: MockReliable;

  const primaryModelId = 'anthropic/claude-sonnet-4-6';
  const fallbackModelId = 'openai/gpt-5.4-mini';
  const primaryModel = { modelId: primaryModelId };
  const fallbackModel = { modelId: fallbackModelId };

  beforeEach(() => {
    jest.clearAllMocks();

    mockRouter = {
      resolveRoute: jest.fn(
        ({
          overrideModelId,
          fallbacks,
          disableFallbacks,
        }: {
          overrideModelId?: string;
          fallbacks?: string[];
          disableFallbacks?: boolean;
        }) => ({
          modelId: overrideModelId ?? primaryModelId,
          fallbacks: disableFallbacks ? undefined : (fallbacks ?? [fallbackModelId]),
        }),
      ),
    };

    mockRegistry = {
      resolve: jest.fn((modelId: string) =>
        modelId === fallbackModelId ? fallbackModel : primaryModel,
      ),
    };

    mockReliable = {
      isModelAvailable: jest.fn().mockReturnValue(true),
      getRetryConfig: jest.fn((config?: Partial<{ maxRetries: number }>) => ({
        maxRetries: 3,
        baseBackoffMs: 0,
        maxBackoffMs: 0,
        ...config,
      })),
      classifyError: jest.fn((error: unknown) => {
        if (error instanceof Error && error.message.includes('401')) {
          return 'non_retryable';
        }
        return 'retryable';
      }),
      shouldRetry: jest.fn(
        (category: string, attempt: number, config: { maxRetries: number }) =>
          category !== 'non_retryable' && attempt < config.maxRetries,
      ),
      getBackoffMs: jest.fn().mockReturnValue(0),
    };

    service = new LlmExecutorService(
      mockRouter as unknown as RouterService,
      mockRegistry as unknown as RegistryService,
      mockReliable as unknown as ReliableService,
    );

    mockOutputObject.mockImplementation(
      (opts: unknown) => opts as unknown as ReturnType<typeof Output.object>,
    );
    mockSupportsVision.mockReturnValue(true);
  });

  function makeGenerateResult(overrides: Record<string, unknown> = {}) {
    return {
      text: 'mock response',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      ...overrides,
    } as Awaited<ReturnType<typeof generateText>>;
  }

  function getGenerateModelIds(): string[] {
    return mockGenerateText.mock.calls.map(
      ([options]) => (options as { model: { modelId: string } }).model.modelId,
    );
  }

  function getStreamModelIds(): string[] {
    return mockStreamText.mock.calls.map(
      ([options]) => (options as { model: { modelId: string } }).model.modelId,
    );
  }

  describe('generate', () => {
    it('should use adaptive thinking for Anthropic Claude 4.7 models', async () => {
      mockGenerateText.mockResolvedValueOnce(makeGenerateResult());

      await service.generate({
        role: ModelRole.Chat,
        modelId: 'anthropic/claude-opus-4-7',
        prompt: 'hello',
        disableFallbacks: true,
        thinking: { type: 'enabled', budgetTokens: 4000 },
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            anthropic: {
              thinking: { type: 'adaptive' },
              effort: 'high',
            },
          },
        }),
      );
    });

    it('should keep budgeted thinking for older Anthropic Claude models', async () => {
      mockGenerateText.mockResolvedValueOnce(makeGenerateResult());

      await service.generate({
        role: ModelRole.Chat,
        modelId: 'anthropic/claude-opus-4-6',
        prompt: 'hello',
        disableFallbacks: true,
        thinking: { type: 'enabled', budgetTokens: 4000 },
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          providerOptions: {
            anthropic: {
              thinking: { type: 'enabled', budgetTokens: 4000 },
            },
          },
        }),
      );
    });

    it('should retry the primary model before falling back', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 500 primary attempt 1'))
        .mockRejectedValueOnce(new Error('HTTP 500 primary attempt 2'))
        .mockRejectedValueOnce(new Error('HTTP 500 primary attempt 3'))
        .mockResolvedValueOnce(makeGenerateResult({ text: 'fallback response' }));

      const result = await service.generate({
        role: ModelRole.Chat,
        prompt: 'hello',
        config: { maxRetries: 3 },
      });

      expect(result.text).toBe('fallback response');
      expect(getGenerateModelIds()).toEqual([
        primaryModelId,
        primaryModelId,
        primaryModelId,
        fallbackModelId,
      ]);
      expect(mockReliable.classifyError).toHaveBeenCalledTimes(3);
      expect(mockReliable.shouldRetry).toHaveBeenNthCalledWith(
        3,
        'retryable',
        3,
        expect.objectContaining({ maxRetries: 3 }),
      );
    });

    it('should stop retrying non-retryable errors and move to fallback immediately', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
        .mockResolvedValueOnce(makeGenerateResult({ text: 'fallback ok' }));

      const result = await service.generate({
        role: ModelRole.Chat,
        prompt: 'hello',
        config: { maxRetries: 3 },
      });

      expect(result.text).toBe('fallback ok');
      expect(getGenerateModelIds()).toEqual([primaryModelId, fallbackModelId]);
      expect(mockReliable.getBackoffMs).not.toHaveBeenCalled();
    });

    it('should not use fallbacks when disableFallbacks is true', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 500 attempt 1'))
        .mockRejectedValueOnce(new Error('HTTP 500 attempt 2'));

      await expect(
        service.generate({
          role: ModelRole.Chat,
          prompt: 'hello',
          disableFallbacks: true,
          config: { maxRetries: 2 },
        }),
      ).rejects.toMatchObject({
        isAgentError: true,
        agentMeta: expect.objectContaining({
          modelsAttempted: [primaryModelId],
          totalAttempts: 2,
        }),
      });

      expect(mockRouter.resolveRoute).toHaveBeenCalledWith({
        role: ModelRole.Chat,
        overrideModelId: undefined,
        fallbacks: undefined,
        disableFallbacks: true,
      });
      expect(getGenerateModelIds()).toEqual([primaryModelId, primaryModelId]);
      expect(mockRegistry.resolve).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateStructured', () => {
    it('should throw when the structured output is empty', async () => {
      const schema = z.object({ score: z.number() });
      mockGenerateText.mockResolvedValueOnce(
        makeGenerateResult({
          output: undefined,
        }),
      );

      await expect(
        service.generateStructured({
          role: ModelRole.Extract,
          prompt: 'extract',
          schema,
        }),
      ).rejects.toThrow('No structured output returned');

      expect(mockOutputObject).toHaveBeenCalledWith(
        expect.objectContaining({
          schema,
          name: 'StructuredOutput',
        }),
      );
    });
  });

  describe('stream', () => {
    it('should try the fallback model when the primary stream initialization fails', async () => {
      const streamResult = {
        textStream: 'fallback stream',
      } as unknown as ReturnType<typeof streamText>;
      mockStreamText
        .mockImplementationOnce(() => {
          throw new Error('primary stream init failed');
        })
        .mockReturnValueOnce(streamResult);

      const result = await service.stream({
        role: ModelRole.Chat,
        prompt: 'hello',
      });

      expect(result).toBe(streamResult);
      expect(getStreamModelIds()).toEqual([primaryModelId, fallbackModelId]);
    });
  });

  describe('supportsVisionInput', () => {
    it('should return true when all models in the route support vision', () => {
      mockSupportsVision.mockReturnValue(true);

      expect(
        service.supportsVisionInput({
          role: ModelRole.Vision,
        }),
      ).toBe(true);

      expect(mockSupportsVision).toHaveBeenNthCalledWith(1, primaryModelId);
      expect(mockSupportsVision).toHaveBeenNthCalledWith(2, fallbackModelId);
    });

    it('should return false when any model in the route lacks vision support', () => {
      mockSupportsVision.mockImplementation((modelId: string) => modelId === primaryModelId);

      expect(
        service.supportsVisionInput({
          role: ModelRole.Vision,
        }),
      ).toBe(false);
    });
  });

  describe('generateSimple', () => {
    it('should return only the text field from generate', async () => {
      mockGenerateText.mockResolvedValueOnce(makeGenerateResult({ text: 'simple text' }));

      const result = await service.generateSimple({
        systemPrompt: 'system prompt',
        userMessage: 'user message',
        role: ModelRole.Chat,
      });

      expect(result).toBe('simple text');
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'system prompt',
          messages: [{ role: 'user', content: 'user message' }],
        }),
      );
    });
  });
});
