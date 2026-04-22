import { Test, TestingModule } from '@nestjs/testing';
import { ReliableService } from '@providers/reliable.service';
import { RegistryService } from '@providers/registry.service';

describe('ReliableService', () => {
  let service: ReliableService;
  let mockRegistry: { resolve: jest.Mock };

  beforeEach(async () => {
    mockRegistry = {
      resolve: jest.fn((modelId: string) => {
        if (modelId === 'anthropic/claude-sonnet-4-6') {
          return { modelId };
        }
        throw new Error(`Provider not found: ${modelId}`);
      }),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [ReliableService, { provide: RegistryService, useValue: mockRegistry }],
    }).compile();

    service = module.get<ReliableService>(ReliableService);
  });

  describe('isModelAvailable', () => {
    it('should return true when the model can be resolved', () => {
      expect(service.isModelAvailable('anthropic/claude-sonnet-4-6')).toBe(true);
      expect(mockRegistry.resolve).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
    });

    it('should return false when resolving the model throws', () => {
      expect(service.isModelAvailable('openai/gpt-4o')).toBe(false);
      expect(mockRegistry.resolve).toHaveBeenCalledWith('openai/gpt-4o');
    });
  });

  describe('classifyError', () => {
    it('should classify auth and request errors as non_retryable', () => {
      expect(service.classifyError(new Error('HTTP 401 Unauthorized'))).toBe('non_retryable');
      expect(service.classifyError(new Error('Invalid API Key provided'))).toBe('non_retryable');
      expect(service.classifyError(new Error('Model not found: gpt-5'))).toBe('non_retryable');
    });

    it('should classify throttling errors as rate_limited', () => {
      expect(service.classifyError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited');
      expect(service.classifyError(new Error('Rate limit exceeded'))).toBe('rate_limited');
    });

    it('should classify other errors as retryable', () => {
      expect(service.classifyError(new Error('Request timeout'))).toBe('retryable');
      expect(service.classifyError('string error')).toBe('retryable');
    });
  });

  describe('getRetryConfig', () => {
    it('should merge user config with defaults', () => {
      expect(
        service.getRetryConfig({
          maxRetries: 5,
          baseBackoffMs: 250,
        }),
      ).toEqual({
        maxRetries: 5,
        baseBackoffMs: 250,
        maxBackoffMs: 10_000,
      });
    });
  });

  describe('shouldRetry', () => {
    it('should never retry non-retryable errors', () => {
      expect(service.shouldRetry('non_retryable', 1)).toBe(false);
    });

    it('should retry retryable errors before reaching max retries', () => {
      expect(service.shouldRetry('retryable', 1, { maxRetries: 3 })).toBe(true);
      expect(service.shouldRetry('rate_limited', 2, { maxRetries: 3 })).toBe(true);
    });

    it('should stop retrying once max retries is reached', () => {
      expect(service.shouldRetry('retryable', 3, { maxRetries: 3 })).toBe(false);
      expect(service.shouldRetry('rate_limited', 2, { maxRetries: 2 })).toBe(false);
    });
  });

  describe('getBackoffMs', () => {
    it('should use exponential backoff with the configured cap', () => {
      expect(service.getBackoffMs(1, new Error('HTTP 500'), { baseBackoffMs: 50 })).toBe(50);
      expect(service.getBackoffMs(3, new Error('HTTP 500'), { baseBackoffMs: 50 })).toBe(200);
      expect(
        service.getBackoffMs(5, new Error('HTTP 500'), {
          baseBackoffMs: 1_000,
          maxBackoffMs: 5_000,
        }),
      ).toBe(5_000);
    });

    it('should honor retry.after hints from the error message', () => {
      expect(service.getBackoffMs(1, new Error('retry.after: 12'))).toBe(12_000);
      expect(service.getBackoffMs(1, new Error('retry.after: 45'))).toBe(30_000);
    });
  });
});
