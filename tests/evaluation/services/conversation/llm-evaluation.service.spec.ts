import { Test, TestingModule } from '@nestjs/testing';
import { LlmEvaluationService } from '@evaluation/llm-evaluation.service';
import { CompletionService } from '@agent/completion.service';
import { SimilarityRating } from '@evaluation/evaluation.types';

describe('LlmEvaluationService', () => {
  let service: LlmEvaluationService;

  const mockCompletion = {
    generateStructured: jest.fn(),
    generateSimple: jest.fn(),
  };

  const makeCompletionResult = (summary: string, score: number) => ({
    object: {
      summary,
      dimensions: {
        factualAccuracy: { score, reason: '事实一致' },
        responseEfficiency: { score, reason: '回复直接' },
        processCompliance: { score, reason: '流程合规' },
        toneNaturalness: { score, reason: '语气自然' },
      },
    },
    usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LlmEvaluationService, { provide: CompletionService, useValue: mockCompletion }],
    }).compile();

    service = module.get<LlmEvaluationService>(LlmEvaluationService);
    jest.clearAllMocks();
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
      mockCompletion.generateStructured.mockResolvedValue(makeCompletionResult('回复内容基本一致', 85));

      const result = await service.evaluate(input);

      expect(result.score).toBe(85);
      expect(result.passed).toBe(true);
      expect(result.summary).toBe('回复内容基本一致');
      expect(result.reason).toBe('事实85 / 效率85 / 合规85 / 话术85：回复内容基本一致');
      expect(result.evaluationId).toBeDefined();
    });

    it('should include token usage', async () => {
      mockCompletion.generateStructured.mockResolvedValue(makeCompletionResult('良好', 70));

      const result = await service.evaluate(input);

      expect(result.tokenUsage).toEqual({
        inputTokens: 50,
        outputTokens: 30,
        totalTokens: 80,
      });
    });

    it('should return zero score on generate failure', async () => {
      mockCompletion.generateStructured.mockRejectedValue(new Error('API connection failed'));

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('评估失败');
    });

    it('should call completion.generateStructured with systemPrompt and messages', async () => {
      mockCompletion.generateStructured.mockResolvedValue(makeCompletionResult('ok', 80));

      await service.evaluate(input);

      expect(mockCompletion.generateStructured).toHaveBeenCalledWith(
        expect.objectContaining({
          systemPrompt: expect.any(String),
          messages: [{ role: 'user', content: expect.any(String) }],
          outputName: 'LlmEvaluationResult',
        }),
      );
    });

    it('should include conversation history in the user message when provided', async () => {
      mockCompletion.generateStructured.mockResolvedValue(makeCompletionResult('ok', 80));

      const inputWithHistory = {
        ...input,
        history: [
          { role: 'user' as const, content: '你好' },
          { role: 'assistant' as const, content: '您好，有什么可以帮您？' },
        ],
      };

      await service.evaluate(inputWithHistory);

      const callArgs = mockCompletion.generateStructured.mock.calls[0][0];
      const userContent = callArgs.messages[0].content;
      expect(userContent).toContain('对话历史');
      expect(userContent).toContain('你好');
    });

    it('should truncate reason to 200 characters', async () => {
      const longSummary = 'a'.repeat(300);
      mockCompletion.generateStructured.mockResolvedValue(makeCompletionResult(longSummary, 80));

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
