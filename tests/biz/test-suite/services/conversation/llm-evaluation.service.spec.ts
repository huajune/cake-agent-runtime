import { Test, TestingModule } from '@nestjs/testing';
import { LlmEvaluationService } from '@biz/test-suite/services/conversation/llm-evaluation.service';
import { RouterService } from '@providers/router.service';
import { SimilarityRating } from '@biz/test-suite/enums/test.enum';

// Mock the 'ai' module
jest.mock('ai', () => ({
  generateText: jest.fn(),
}));

import { generateText } from 'ai';

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

describe('LlmEvaluationService', () => {
  let service: LlmEvaluationService;

  const mockRouter = {
    resolveByRole: jest.fn().mockReturnValue({ modelId: 'test-model' }),
  };

  const makeGenerateResult = (text: string) => ({
    text,
    usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80, promptTokens: 50, completionTokens: 30 },
    finishReason: 'stop' as const,
    response: { id: 'test', timestamp: new Date(), modelId: 'test-model', headers: {} },
    reasoning: undefined,
    reasoningDetails: [],
    experimental_output: undefined,
    sources: [],
    files: [],
    steps: [],
    request: { body: '' },
    warnings: [],
    providerMetadata: undefined,
    experimental_providerMetadata: undefined,
    toolCalls: [],
    toolResults: [],
    responseMessages: [],
    roundtrips: [],
    toJsonResponse: jest.fn(),
    toDataStream: jest.fn(),
    toDataStreamResponse: jest.fn(),
    pipeDataStreamToResponse: jest.fn(),
    toTextStreamResponse: jest.fn(),
    pipeTextStreamToResponse: jest.fn(),
    textStream: {} as any,
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LlmEvaluationService, { provide: RouterService, useValue: mockRouter }],
    }).compile();

    service = module.get<LlmEvaluationService>(LlmEvaluationService);
    jest.clearAllMocks();
    mockRouter.resolveByRole.mockReturnValue({ modelId: 'test-model' });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== evaluate ==========

  describe('evaluate', () => {
    const input = {
      userMessage: '这还招人吗',
      expectedOutput: '是的，目前还在招聘中',
      actualOutput: '是的，我们还在招人',
    };

    it('should return evaluation result with correct score and passed flag', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 85, "passed": true, "reason": "回复内容基本一致"}') as any,
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(85);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('回复内容基本一致');
      expect(result.evaluationId).toBeDefined();
    });

    it('should include token usage when available', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 70, "passed": true, "reason": "良好"}') as any,
      );

      const result = await service.evaluate(input);

      expect(result.tokenUsage).toEqual({
        inputTokens: 50,
        outputTokens: 30,
        totalTokens: 80,
      });
    });

    it('should return zero score on generateText failure', async () => {
      mockGenerateText.mockRejectedValue(new Error('API connection failed'));

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('评估失败');
    });

    it('should handle markdown code block wrapped JSON', async () => {
      const jsonWithMarkdown = '```json\n{"score": 75, "passed": true, "reason": "良好"}\n```';
      mockGenerateText.mockResolvedValue(makeGenerateResult(jsonWithMarkdown) as any);

      const result = await service.evaluate(input);

      expect(result.score).toBe(75);
      expect(result.passed).toBe(true);
    });

    it('should call router.resolveByRole with "chat"', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 80, "passed": true, "reason": "ok"}') as any,
      );

      await service.evaluate(input);

      expect(mockRouter.resolveByRole).toHaveBeenCalledWith('chat');
    });

    it('should include conversation history in the user message when provided', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 80, "passed": true, "reason": "ok"}') as any,
      );

      const inputWithHistory = {
        ...input,
        history: [
          { role: 'user' as const, content: '你好' },
          { role: 'assistant' as const, content: '您好，有什么可以帮您？' },
        ],
      };

      await service.evaluate(inputWithHistory);

      const callArgs = mockGenerateText.mock.calls[0][0];
      expect(callArgs.prompt).toContain('对话历史');
      expect(callArgs.prompt).toContain('你好');
    });

    it('should auto-correct passed flag when inconsistent with score', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 75, "passed": false, "reason": "inconsistent"}') as any,
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(75);
      expect(result.passed).toBe(true); // auto-corrected
    });

    it('should clamp score to 0-100 range', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 150, "passed": true, "reason": "out of range"}') as any,
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(100);
    });

    it('should return zero score when JSON is malformed', async () => {
      mockGenerateText.mockResolvedValue(makeGenerateResult('not valid json at all') as any);

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
    });

    it('should return zero score when JSON is missing required fields', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": 80}') as any, // missing passed and reason
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
    });

    it('should return zero score when field types are wrong', async () => {
      mockGenerateText.mockResolvedValue(
        makeGenerateResult('{"score": "high", "passed": "yes", "reason": 123}') as any,
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
    });

    it('should truncate reason to 200 characters', async () => {
      const longReason = 'a'.repeat(300);
      mockGenerateText.mockResolvedValue(
        makeGenerateResult(`{"score": 80, "passed": true, "reason": "${longReason}"}`) as any,
      );

      const result = await service.evaluate(input);

      expect(result.reason.length).toBeLessThanOrEqual(200);
    });
  });

  // ========== getRating ==========

  describe('getRating', () => {
    it('should return EXCELLENT for score >= 80', () => {
      expect(service.getRating(80)).toBe(SimilarityRating.EXCELLENT);
      expect(service.getRating(100)).toBe(SimilarityRating.EXCELLENT);
      expect(service.getRating(95)).toBe(SimilarityRating.EXCELLENT);
    });

    it('should return GOOD for score in range 60-79', () => {
      expect(service.getRating(60)).toBe(SimilarityRating.GOOD);
      expect(service.getRating(79)).toBe(SimilarityRating.GOOD);
    });

    it('should return FAIR for score in range 40-59', () => {
      expect(service.getRating(40)).toBe(SimilarityRating.FAIR);
      expect(service.getRating(59)).toBe(SimilarityRating.FAIR);
    });

    it('should return POOR for score below 40', () => {
      expect(service.getRating(0)).toBe(SimilarityRating.POOR);
      expect(service.getRating(39)).toBe(SimilarityRating.POOR);
    });
  });
});
