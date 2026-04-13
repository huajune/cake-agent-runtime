import { Test, TestingModule } from '@nestjs/testing';
import { ReliableService } from '@providers/reliable.service';
import { RegistryService } from '@providers/registry.service';

// Mock AI SDK
const mockGenerateText = jest.fn();
const mockStreamText = jest.fn();
jest.mock('ai', () => ({
  generateText: (...args: unknown[]) => mockGenerateText(...args),
  streamText: (...args: unknown[]) => mockStreamText(...args),
}));

describe('ReliableService', () => {
  let service: ReliableService;
  let mockRegistry: { resolve: jest.Mock };

  const mockModel = { modelId: 'anthropic/claude-sonnet-4-6', provider: 'anthropic' };
  const mockFallbackModel = { modelId: 'openai/gpt-4o', provider: 'openai' };
  const mockFallback2Model = { modelId: 'deepseek/deepseek-chat', provider: 'deepseek' };

  beforeEach(async () => {
    jest.clearAllMocks();

    mockRegistry = {
      resolve: jest.fn((id: string) => {
        const models: Record<string, unknown> = {
          'anthropic/claude-sonnet-4-6': mockModel,
          'openai/gpt-4o': mockFallbackModel,
          'deepseek/deepseek-chat': mockFallback2Model,
        };
        if (!models[id]) throw new Error(`Provider not found: ${id}`);
        return models[id];
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReliableService,
        { provide: RegistryService, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<ReliableService>(ReliableService);
  });

  describe('classifyError', () => {
    it('should classify 401 as non_retryable', () => {
      expect(service.classifyError(new Error('HTTP 401 Unauthorized'))).toBe('non_retryable');
    });

    it('should classify 403 as non_retryable', () => {
      expect(service.classifyError(new Error('HTTP 403 Forbidden'))).toBe('non_retryable');
    });

    it('should classify 404 as non_retryable', () => {
      expect(service.classifyError(new Error('HTTP 404 Not Found'))).toBe('non_retryable');
    });

    it('should classify 400 as non_retryable', () => {
      expect(service.classifyError(new Error('HTTP 400 Bad Request'))).toBe('non_retryable');
    });

    it('should classify "invalid api key" as non_retryable', () => {
      expect(service.classifyError(new Error('Invalid API Key provided'))).toBe('non_retryable');
    });

    it('should classify "model not found" as non_retryable', () => {
      expect(service.classifyError(new Error('Model not found: gpt-5'))).toBe('non_retryable');
    });

    it('should classify "insufficient balance" as non_retryable', () => {
      expect(service.classifyError(new Error('Insufficient balance'))).toBe('non_retryable');
    });

    it('should classify 429 as rate_limited', () => {
      expect(service.classifyError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited');
    });

    it('should classify "rate limit" as rate_limited', () => {
      expect(service.classifyError(new Error('Rate limit exceeded'))).toBe('rate_limited');
    });

    it('should classify 500 as retryable', () => {
      expect(service.classifyError(new Error('HTTP 500 Internal Server Error'))).toBe('retryable');
    });

    it('should classify timeout as retryable', () => {
      expect(service.classifyError(new Error('Request timeout'))).toBe('retryable');
    });

    it('should classify non-Error values as retryable', () => {
      expect(service.classifyError('string error')).toBe('retryable');
      expect(service.classifyError(null)).toBe('retryable');
    });
  });

  describe('resolveWithFallback', () => {
    it('should return primary model when available', () => {
      const result = service.resolveWithFallback('anthropic/claude-sonnet-4-6');
      expect(result).toBe(mockModel);
    });

    it('should fallback when primary fails', () => {
      mockRegistry.resolve.mockImplementationOnce(() => {
        throw new Error('Provider not found');
      });
      const result = service.resolveWithFallback('unknown/model', ['openai/gpt-4o']);
      expect(result).toBe(mockFallbackModel);
    });

    it('should throw when primary fails and no fallbacks', () => {
      expect(() => service.resolveWithFallback('unknown/model')).toThrow('模型解析失败');
    });

    it('should throw when all fallbacks fail', () => {
      mockRegistry.resolve.mockImplementation(() => {
        throw new Error('Not found');
      });
      expect(() =>
        service.resolveWithFallback('unknown/a', ['unknown/b', 'unknown/c']),
      ).toThrow('所有 fallback 均失败');
    });

    it('should try fallbacks in order', () => {
      mockRegistry.resolve
        .mockImplementationOnce(() => {
          throw new Error('Primary failed');
        })
        .mockImplementationOnce(() => {
          throw new Error('Fallback 1 failed');
        })
        .mockReturnValueOnce(mockFallback2Model);

      const result = service.resolveWithFallback('unknown/a', [
        'unknown/b',
        'deepseek/deepseek-chat',
      ]);
      expect(result).toBe(mockFallback2Model);
    });
  });

  describe('generateText', () => {
    const baseParams = { prompt: 'Hello' };

    it('should call generateText with resolved model', async () => {
      const expected = { text: 'response' };
      mockGenerateText.mockResolvedValueOnce(expected);

      const result = await service.generateText(
        'anthropic/claude-sonnet-4-6',
        baseParams,
      );
      expect(result).toBe(expected);
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({ model: mockModel, prompt: 'Hello' }),
      );
    });

    it('should retry on retryable error', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 500 Internal Server Error'))
        .mockResolvedValueOnce({ text: 'ok' });

      const result = await service.generateText(
        'anthropic/claude-sonnet-4-6',
        baseParams,
        undefined,
        { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 10 },
      );
      expect(result).toEqual({ text: 'ok' });
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non_retryable error, move to fallback', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 401 Unauthorized'))
        .mockResolvedValueOnce({ text: 'fallback ok' });

      const result = await service.generateText(
        'anthropic/claude-sonnet-4-6',
        baseParams,
        ['openai/gpt-4o'],
        { maxRetries: 3, baseBackoffMs: 1, maxBackoffMs: 10 },
      );
      expect(result).toEqual({ text: 'fallback ok' });
      // 1 attempt on primary (non-retryable breaks), 1 on fallback
      expect(mockGenerateText).toHaveBeenCalledTimes(2);
    });

    it('should fallback to next model after retries exhausted', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockRejectedValueOnce(new Error('HTTP 500'))
        .mockResolvedValueOnce({ text: 'fallback ok' });

      const result = await service.generateText(
        'anthropic/claude-sonnet-4-6',
        baseParams,
        ['openai/gpt-4o'],
        { maxRetries: 2, baseBackoffMs: 1, maxBackoffMs: 10 },
      );
      expect(result).toEqual({ text: 'fallback ok' });
    });

    it('should throw when all models and retries exhausted', async () => {
      mockGenerateText.mockRejectedValue(new Error('HTTP 500'));

      await expect(
        service.generateText(
          'anthropic/claude-sonnet-4-6',
          baseParams,
          ['openai/gpt-4o'],
          { maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 10 },
        ),
      ).rejects.toThrow('所有模型均失败');
    });

    it('should attach structured agent metadata when all models fail', async () => {
      mockGenerateText
        .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'))
        .mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'));

      const error = await service
        .generateText(
          'anthropic/claude-sonnet-4-6',
          baseParams,
          ['openai/gpt-4o'],
          { maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 10 },
        )
        .catch((err) => err);

      expect(error).toMatchObject({
        isAgentError: true,
        agentMeta: expect.objectContaining({
          modelsAttempted: ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o'],
          totalAttempts: 2,
          lastCategory: 'rate_limited',
        }),
      });
    });

    it('should skip unregistered models in chain', async () => {
      mockGenerateText.mockResolvedValueOnce({ text: 'ok' });

      const result = await service.generateText(
        'unknown/model',
        baseParams,
        ['anthropic/claude-sonnet-4-6'],
        { maxRetries: 1, baseBackoffMs: 1, maxBackoffMs: 10 },
      );
      expect(result).toEqual({ text: 'ok' });
    });
  });

  describe('streamText', () => {
    it('should call streamText with resolved model', () => {
      const mockStream = { textStream: 'stream' };
      mockStreamText.mockReturnValueOnce(mockStream);

      const result = service.streamText('anthropic/claude-sonnet-4-6', { prompt: 'Hi' });
      expect(result).toBe(mockStream);
      expect(mockStreamText).toHaveBeenCalledWith(
        expect.objectContaining({ model: mockModel, prompt: 'Hi' }),
      );
    });

    it('should use fallback model for stream when primary unavailable', () => {
      mockRegistry.resolve
        .mockImplementationOnce(() => {
          throw new Error('Not found');
        })
        .mockReturnValueOnce(mockFallbackModel);

      const mockStream = { textStream: 'stream' };
      mockStreamText.mockReturnValueOnce(mockStream);

      const result = service.streamText('unknown/model', { prompt: 'Hi' }, ['openai/gpt-4o']);
      expect(result).toBe(mockStream);
    });
  });
});
