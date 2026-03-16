import { Test, TestingModule } from '@nestjs/testing';
import { LlmEvaluationService } from '@biz/test-suite/services/conversation/llm-evaluation.service';
import { AgentService } from '@agent';
import { SimilarityRating } from '@biz/test-suite/enums/test.enum';

describe('LlmEvaluationService', () => {
  let service: LlmEvaluationService;
  let agentService: jest.Mocked<AgentService>;

  const mockAgentService = {
    chat: jest.fn(),
  };

  const makeAgentResult = (jsonText: string) => ({
    status: 'success',
    data: {
      messages: [{ parts: [{ text: jsonText }] }],
      usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
    },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [LlmEvaluationService, { provide: AgentService, useValue: mockAgentService }],
    }).compile();

    service = module.get<LlmEvaluationService>(LlmEvaluationService);
    agentService = module.get(AgentService);

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
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 85, "passed": true, "reason": "回复内容基本一致"}'),
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(85);
      expect(result.passed).toBe(true);
      expect(result.reason).toBe('回复内容基本一致');
      expect(result.evaluationId).toBeDefined();
    });

    it('should include token usage when available', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 70, "passed": true, "reason": "良好"}'),
      );

      const result = await service.evaluate(input);

      expect(result.tokenUsage).toEqual({
        inputTokens: 50,
        outputTokens: 30,
        totalTokens: 80,
      });
    });

    it('should return zero score on agent chat failure', async () => {
      mockAgentService.chat.mockRejectedValue(new Error('API connection failed'));

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
      expect(result.reason).toContain('评估失败');
    });

    it('should return zero score when agent response is empty', async () => {
      mockAgentService.chat.mockResolvedValue({
        status: 'error',
        error: { code: 'ERR', message: 'failed' },
      });

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
    });

    it('should handle markdown code block wrapped JSON', async () => {
      const jsonWithMarkdown = '```json\n{"score": 75, "passed": true, "reason": "良好"}\n```';
      mockAgentService.chat.mockResolvedValue(makeAgentResult(jsonWithMarkdown));

      const result = await service.evaluate(input);

      expect(result.score).toBe(75);
      expect(result.passed).toBe(true);
    });

    it('should call agent with empty allowedTools to disable tools', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 80, "passed": true, "reason": "ok"}'),
      );

      await service.evaluate(input);

      expect(agentService.chat).toHaveBeenCalledWith(
        expect.objectContaining({
          allowedTools: [],
        }),
      );
    });

    it('should include conversation history in the user message when provided', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 80, "passed": true, "reason": "ok"}'),
      );

      const inputWithHistory = {
        ...input,
        history: [
          { role: 'user' as const, content: '你好' },
          { role: 'assistant' as const, content: '您好，有什么可以帮您？' },
        ],
      };

      await service.evaluate(inputWithHistory);

      const chatCall = agentService.chat.mock.calls[0][0];
      expect(chatCall.userMessage).toContain('对话历史');
      expect(chatCall.userMessage).toContain('你好');
    });

    it('should auto-correct passed flag when inconsistent with score', async () => {
      // score >= 60 should be true, but JSON says false
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 75, "passed": false, "reason": "inconsistent"}'),
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(75);
      expect(result.passed).toBe(true); // auto-corrected
    });

    it('should clamp score to 0-100 range', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 150, "passed": true, "reason": "out of range"}'),
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(100);
    });

    it('should return zero score when JSON is malformed', async () => {
      mockAgentService.chat.mockResolvedValue(makeAgentResult('not valid json at all'));

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
      expect(result.passed).toBe(false);
    });

    it('should return zero score when JSON is missing required fields', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": 80}'), // missing passed and reason
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
    });

    it('should return zero score when field types are wrong', async () => {
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult('{"score": "high", "passed": "yes", "reason": 123}'),
      );

      const result = await service.evaluate(input);

      expect(result.score).toBe(0);
    });

    it('should truncate reason to 200 characters', async () => {
      const longReason = 'a'.repeat(300);
      mockAgentService.chat.mockResolvedValue(
        makeAgentResult(`{"score": 80, "passed": true, "reason": "${longReason}"}`),
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
