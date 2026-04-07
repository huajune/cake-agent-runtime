import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { CompletionService } from '@agent/completion.service';
import { RouterService } from '@providers/router.service';
import { ModelRole } from '@providers/types';

// Mock the 'ai' module before any imports that use it
jest.mock('ai', () => ({
  generateText: jest.fn(),
  ModelMessage: {},
  Output: {
    object: jest.fn().mockImplementation((opts: unknown) => opts),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateText, Output } = require('ai');
const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;
const mockOutput = Output.object as jest.MockedFunction<typeof Output.object>;

describe('CompletionService', () => {
  let service: CompletionService;

  const mockModel = { modelId: 'test-model' };

  const mockRouter = {
    resolveByRole: jest.fn().mockReturnValue(mockModel),
    resolve: jest.fn().mockReturnValue(mockModel),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => defaultValue),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CompletionService,
        { provide: RouterService, useValue: mockRouter },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<CompletionService>(CompletionService);
    jest.clearAllMocks();
    mockRouter.resolveByRole.mockReturnValue(mockModel);
    mockRouter.resolve.mockReturnValue(mockModel);
    mockGenerateText.mockResolvedValue({
      text: 'mock response',
      usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('generate', () => {
    it('should call generateText with correct params and return result', async () => {
      const result = await service.generate({
        systemPrompt: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          model: mockModel,
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
      );
      expect(result.text).toBe('mock response');
      expect(result.usage.totalTokens).toBe(30);
    });

    it('should use resolveByRole with default role "chat"', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(mockRouter.resolveByRole).toHaveBeenCalledWith('chat');
    });

    it('should use resolveByRole with custom role', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        role: ModelRole.Extract,
      });

      expect(mockRouter.resolveByRole).toHaveBeenCalledWith(ModelRole.Extract);
    });

    it('should use resolve with modelId when provided (overrides role)', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        modelId: 'anthropic/claude-sonnet-4-6',
      });

      expect(mockRouter.resolve).toHaveBeenCalledWith('anthropic/claude-sonnet-4-6');
      expect(mockRouter.resolveByRole).not.toHaveBeenCalled();
    });

    it('should pass temperature and maxOutputTokens', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.5,
        maxOutputTokens: 100,
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          maxOutputTokens: 100,
        }),
      );
    });

    it('should use default maxOutputTokens when not explicitly provided', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 4096,
        }),
      );
    });

    it('should allow explicit maxOutputTokens to override default', async () => {
      await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
        maxOutputTokens: 1000,
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          maxOutputTokens: 1000,
        }),
      );
    });

    it('should handle missing inputTokens/outputTokens gracefully', async () => {
      mockGenerateText.mockResolvedValue({
        text: 'ok',
        usage: { totalTokens: 50 },
      });

      const result = await service.generate({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(result.usage.inputTokens).toBe(0);
      expect(result.usage.outputTokens).toBe(0);
      expect(result.usage.totalTokens).toBe(50);
    });
  });

  describe('generateSimple', () => {
    it('should wrap userMessage into messages and return text only', async () => {
      const text = await service.generateSimple({
        systemPrompt: 'You evaluate things.',
        userMessage: 'Is this good?',
      });

      expect(text).toBe('mock response');
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: 'You evaluate things.',
          messages: [{ role: 'user', content: 'Is this good?' }],
        }),
      );
    });

    it('should pass role through to generate', async () => {
      await service.generateSimple({
        systemPrompt: 'test',
        userMessage: 'hi',
        role: ModelRole.Vision,
      });

      expect(mockRouter.resolveByRole).toHaveBeenCalledWith(ModelRole.Vision);
    });

    it('should pass modelId through to generate', async () => {
      await service.generateSimple({
        systemPrompt: 'test',
        userMessage: 'hi',
        modelId: 'openai/gpt-4o',
      });

      expect(mockRouter.resolve).toHaveBeenCalledWith('openai/gpt-4o');
    });
  });

  describe('generateStructured', () => {
    it('should call generateText with structured output config and return parsed object', async () => {
      mockGenerateText.mockResolvedValue({
        output: { score: 80, reason: '结构化成功' },
        usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
      });

      const schema = require('zod').z.object({
        score: require('zod').z.number(),
        reason: require('zod').z.string(),
      });

      const result = await service.generateStructured({
        systemPrompt: 'structured test',
        messages: [{ role: 'user', content: 'hi' }],
        schema,
        outputName: 'EvalResult',
      });

      expect(mockOutput).toHaveBeenCalledWith(
        expect.objectContaining({
          schema,
          name: 'EvalResult',
        }),
      );
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          output: expect.objectContaining({
            schema,
            name: 'EvalResult',
          }),
        }),
      );
      expect(result.object).toEqual({ score: 80, reason: '结构化成功' });
    });

    it('should throw when structured output is missing', async () => {
      const schema = require('zod').z.object({
        score: require('zod').z.number(),
      });
      mockGenerateText.mockResolvedValue({
        output: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });

      await expect(
        service.generateStructured({
          systemPrompt: 'structured test',
          messages: [{ role: 'user', content: 'hi' }],
          schema,
        }),
      ).rejects.toThrow('No structured output returned');
    });
  });
});
