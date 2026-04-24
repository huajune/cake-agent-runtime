import { Test, TestingModule } from '@nestjs/testing';
import { ConversationTestService } from '@biz/test-suite/services/conversation-test.service';
import { AgentRunnerService } from '@agent/runner.service';
import { ContextService } from '@agent/context/context.service';
import { LlmEvaluationService } from '@evaluation/llm-evaluation.service';
import { ConversationParserService } from '@evaluation/conversation-parser.service';
import { ConversationSnapshotRepository } from '@biz/test-suite/repositories/conversation-snapshot.repository';
import { TestExecutionRepository } from '@biz/test-suite/repositories/test-execution.repository';
import { TestWriteBackService } from '@biz/test-suite/services/test-write-back.service';
import {
  ExecutionStatus,
  ReviewStatus,
  ConversationSourceStatus,
  SimilarityRating,
  FeishuTestStatus,
  ReviewerSource,
} from '@biz/test-suite/enums/test.enum';
import { ConversationSnapshotRecord } from '@biz/test-suite/entities/conversation-snapshot.entity';

describe('ConversationTestService', () => {
  let service: ConversationTestService;
  let orchestrator: jest.Mocked<AgentRunnerService>;
  let llmEvaluationService: jest.Mocked<LlmEvaluationService>;
  let parserService: jest.Mocked<ConversationParserService>;
  let conversationSnapshotRepository: jest.Mocked<ConversationSnapshotRepository>;
  let executionRepository: jest.Mocked<TestExecutionRepository>;
  let writeBackService: jest.Mocked<TestWriteBackService>;

  const mockOrchestrator = {
    invoke: jest.fn(),
  };

  const mockContext = {
    compose: jest.fn().mockResolvedValue({
      systemPrompt: 'test system prompt',
      stageGoals: { initial: { description: 'test' } },
    }),
  };

  const mockLlmEvaluationService = {
    evaluate: jest.fn(),
    getRating: jest.fn(),
  };

  const mockParserService = {
    parseConversation: jest.fn(),
    splitIntoTurns: jest.fn(),
    extractResponseText: jest.fn(),
    extractToolCalls: jest.fn(),
  };

  const mockConversationSnapshotRepository = {
    findById: jest.fn(),
    findByBatchId: jest.fn(),
    findByBatchIdPaginated: jest.fn(),
    updateStatus: jest.fn(),
    updateSource: jest.fn(),
  };

  const mockExecutionRepository = {
    findById: jest.fn(),
    findByConversationSourceId: jest.fn(),
    findByConversationSourceAndTurn: jest.fn(),
    create: jest.fn(),
    updateExecution: jest.fn(),
    updateReview: jest.fn(),
  };

  const mockWriteBackService = {
    writeBackSimilarityScore: jest.fn(),
  };

  const makeSource = (
    overrides: Partial<ConversationSnapshotRecord> = {},
  ): ConversationSnapshotRecord =>
    ({
      id: 'source-1',
      batch_id: 'batch-1',
      conversation_id: 'conv-001',
      participant_name: 'Alice',
      full_conversation: [
        { role: 'user', content: '你好', timestamp: '17:00' },
        { role: 'assistant', content: '您好，有什么可以帮您？', timestamp: '17:01' },
      ],
      status: ConversationSourceStatus.PENDING,
      total_turns: 1,
      avg_similarity_score: null,
      feishu_record_id: 'rec-001',
      ...overrides,
    }) as ConversationSnapshotRecord;

  const makeOrchestratorSuccess = (text = 'AI回复') => ({
    text,
    steps: 1,
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ConversationTestService,
        { provide: AgentRunnerService, useValue: mockOrchestrator },
        { provide: ContextService, useValue: mockContext },
        { provide: LlmEvaluationService, useValue: mockLlmEvaluationService },
        { provide: ConversationParserService, useValue: mockParserService },
        { provide: ConversationSnapshotRepository, useValue: mockConversationSnapshotRepository },
        { provide: TestExecutionRepository, useValue: mockExecutionRepository },
        { provide: TestWriteBackService, useValue: mockWriteBackService },
      ],
    }).compile();

    service = module.get<ConversationTestService>(ConversationTestService);
    orchestrator = module.get(AgentRunnerService);
    llmEvaluationService = module.get(LlmEvaluationService);
    parserService = module.get(ConversationParserService);
    conversationSnapshotRepository = module.get(ConversationSnapshotRepository);
    executionRepository = module.get(TestExecutionRepository);
    writeBackService = module.get(TestWriteBackService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ========== parseConversation (delegation) ==========

  describe('parseConversation', () => {
    it('should delegate to parserService', () => {
      const mockResult = { success: true, messages: [], totalTurns: 0 };
      mockParserService.parseConversation.mockReturnValue(mockResult);

      const result = service.parseConversation('raw text');

      expect(parserService.parseConversation).toHaveBeenCalledWith('raw text');
      expect(result).toBe(mockResult);
    });
  });

  // ========== splitIntoTurns (delegation) ==========

  describe('splitIntoTurns', () => {
    it('should delegate to parserService', () => {
      const messages = [{ role: 'user' as const, content: 'hello', timestamp: '17:00' }];
      const mockTurns = [{ turnNumber: 1, userMessage: 'hello', expectedOutput: '', history: [] }];
      mockParserService.splitIntoTurns.mockReturnValue(mockTurns);

      const result = service.splitIntoTurns(messages);

      expect(parserService.splitIntoTurns).toHaveBeenCalledWith(messages);
      expect(result).toBe(mockTurns);
    });
  });

  // ========== executeConversation ==========

  describe('executeConversation', () => {
    const mockTurns = [
      {
        turnNumber: 1,
        userMessage: '你好',
        expectedOutput: '您好，有什么可以帮您？',
        history: [],
      },
    ];

    beforeEach(() => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(makeSource());
      mockConversationSnapshotRepository.updateStatus.mockResolvedValue(undefined);
      mockConversationSnapshotRepository.updateSource.mockResolvedValue(undefined);
      mockParserService.splitIntoTurns.mockReturnValue(mockTurns);
      mockExecutionRepository.findByConversationSourceAndTurn.mockResolvedValue(null);
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-1' } as any);
      mockOrchestrator.invoke.mockResolvedValue(makeOrchestratorSuccess('您好，有什么可以帮您'));
      mockLlmEvaluationService.evaluate.mockResolvedValue({
        score: 85,
        passed: true,
        reason: '回复正确',
        evaluationId: 'eval-1',
      });
      mockLlmEvaluationService.getRating.mockReturnValue(SimilarityRating.EXCELLENT);
    });

    it('should throw error when source not found', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(null);

      await expect(service.executeConversation('non-existent')).rejects.toThrow('对话源不存在');
    });

    it('should execute conversation and return result', async () => {
      const result = await service.executeConversation('source-1');

      expect(result.sourceId).toBe('source-1');
      expect(result.totalTurns).toBe(1);
      expect(result.executedTurns).toBe(1);
      expect(result.avgSimilarityScore).toBe(85);
    });

    it('should update source status to RUNNING at start', async () => {
      await service.executeConversation('source-1');

      expect(conversationSnapshotRepository.updateStatus).toHaveBeenCalledWith(
        'source-1',
        ConversationSourceStatus.RUNNING,
      );
    });

    it('should update source status to COMPLETED on success', async () => {
      await service.executeConversation('source-1');

      expect(conversationSnapshotRepository.updateSource).toHaveBeenCalledWith(
        'source-1',
        expect.objectContaining({ status: ConversationSourceStatus.COMPLETED }),
      );
    });

    it('should set source to FAILED and re-throw when repository fails', async () => {
      mockConversationSnapshotRepository.updateSource.mockRejectedValue(
        new Error('Database write error'),
      );

      await expect(service.executeConversation('source-1')).rejects.toThrow('Database write error');

      expect(conversationSnapshotRepository.updateStatus).toHaveBeenCalledWith(
        'source-1',
        ConversationSourceStatus.FAILED,
      );
    });

    it('should handle agent failures within turns gracefully (does not rethrow)', async () => {
      mockOrchestrator.invoke.mockRejectedValue(new Error('Agent API down'));

      const result = await service.executeConversation('source-1');

      expect(result.turns[0].executionStatus).toBe(ExecutionStatus.FAILURE);
    });

    it('should skip LLM evaluation when orchestrator throws', async () => {
      mockOrchestrator.invoke.mockRejectedValue(new Error('Agent error'));

      await service.executeConversation('source-1');

      expect(llmEvaluationService.evaluate).not.toHaveBeenCalled();
    });

    it('should skip LLM evaluation when expectedOutput is empty', async () => {
      mockParserService.splitIntoTurns.mockReturnValue([
        { turnNumber: 1, userMessage: '你好', expectedOutput: '', history: [] },
      ]);

      await service.executeConversation('source-1');

      expect(llmEvaluationService.evaluate).not.toHaveBeenCalled();
    });

    it('should reuse existing execution when forceRerun is false', async () => {
      const existingExec = {
        id: 'existing-exec',
        execution_status: ExecutionStatus.SUCCESS,
        similarity_score: 75,
      } as any;
      mockExecutionRepository.findByConversationSourceAndTurn.mockResolvedValue(existingExec);
      mockLlmEvaluationService.getRating.mockReturnValue(SimilarityRating.GOOD);

      const result = await service.executeConversation('source-1', false);

      expect(orchestrator.invoke).not.toHaveBeenCalled();
      expect(result.turns[0].similarityScore).toBe(75);
    });

    it('should re-execute when forceRerun is true', async () => {
      const existingExec = { id: 'existing-exec', similarity_score: 75 } as any;
      mockExecutionRepository.findByConversationSourceAndTurn.mockResolvedValue(existingExec);

      await service.executeConversation('source-1', true);

      expect(orchestrator.invoke).toHaveBeenCalled();
    });

    it('should use participant_name as userId', async () => {
      await service.executeConversation('source-1');

      expect(orchestrator.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'Alice' }),
      );
    });

    it('should throw error when source has no participant_name', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(
        makeSource({ participant_name: null as unknown as string }),
      );

      await expect(service.executeConversation('source-1')).rejects.toThrow(
        '缺少 participant_name',
      );
    });

    it('should fail instead of completing when no executable turns are parsed', async () => {
      mockParserService.splitIntoTurns.mockReturnValue([]);

      await expect(service.executeConversation('source-1')).rejects.toThrow(
        '没有可执行的候选人轮次',
      );

      expect(conversationSnapshotRepository.updateSource).not.toHaveBeenCalledWith(
        'source-1',
        expect.objectContaining({ status: ConversationSourceStatus.COMPLETED }),
      );
      expect(conversationSnapshotRepository.updateStatus).toHaveBeenCalledWith(
        'source-1',
        ConversationSourceStatus.FAILED,
      );
    });

    it('should calculate minSimilarityScore correctly', async () => {
      mockParserService.splitIntoTurns.mockReturnValue([
        { turnNumber: 1, userMessage: 'q1', expectedOutput: 'e1', history: [] },
        { turnNumber: 2, userMessage: 'q2', expectedOutput: 'e2', history: [] },
      ]);
      mockExecutionRepository.create.mockResolvedValue({ id: 'exec-x' } as any);

      let callCount = 0;
      mockLlmEvaluationService.evaluate.mockImplementation(() => {
        callCount++;
        return Promise.resolve({
          score: callCount === 1 ? 70 : 90,
          passed: true,
          reason: 'ok',
          evaluationId: `eval-${callCount}`,
        });
      });
      mockLlmEvaluationService.getRating.mockReturnValue(SimilarityRating.GOOD);

      const result = await service.executeConversation('source-1');

      expect(result.minSimilarityScore).toBe(70);
      expect(result.avgSimilarityScore).toBe(80);
    });
  });

  // ========== getConversationTurns ==========

  describe('getConversationTurns', () => {
    it('should throw error when source not found', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(null);

      await expect(service.getConversationTurns('non-existent')).rejects.toThrow('对话源不存在');
    });

    it('should return turns with source info', async () => {
      const source = makeSource({
        total_turns: 2,
        avg_similarity_score: 80,
      });
      mockConversationSnapshotRepository.findById.mockResolvedValue(source);
      mockExecutionRepository.findByConversationSourceId.mockResolvedValue([
        {
          id: 'exec-1',
          turn_number: 1,
          input_message: '你好',
          expected_output: '您好',
          actual_output: '您好，有什么可以帮您',
          similarity_score: 80,
          evaluation_reason: '良好',
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PASSED,
          tool_calls: null,
          duration_ms: 1000,
          token_usage: null,
          created_at: new Date().toISOString(),
        },
      ] as any);
      mockParserService.splitIntoTurns.mockReturnValue([
        { turnNumber: 1, userMessage: '你好', expectedOutput: '您好', history: [] },
      ]);

      const result = await service.getConversationTurns('source-1');

      expect(result.conversationInfo.id).toBe('source-1');
      expect(result.conversationInfo.totalTurns).toBe(2);
      expect(result.turns).toHaveLength(1);
      expect(result.turns[0].turnNumber).toBe(1);
    });

    it('should sort turns by turnNumber ascending', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(makeSource());
      mockExecutionRepository.findByConversationSourceId.mockResolvedValue([
        {
          id: 'exec-2',
          turn_number: 2,
          input_message: '问2',
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PENDING,
          created_at: new Date().toISOString(),
        },
        {
          id: 'exec-1',
          turn_number: 1,
          input_message: '问1',
          execution_status: ExecutionStatus.SUCCESS,
          review_status: ReviewStatus.PENDING,
          created_at: new Date().toISOString(),
        },
      ] as any);
      mockParserService.splitIntoTurns.mockReturnValue([]);

      const result = await service.getConversationTurns('source-1');

      expect(result.turns[0].turnNumber).toBe(1);
      expect(result.turns[1].turnNumber).toBe(2);
    });
  });

  // ========== getConversationSources ==========

  describe('getConversationSources', () => {
    it('should return paginated sources', async () => {
      mockConversationSnapshotRepository.findByBatchIdPaginated.mockResolvedValue({
        data: [
          {
            id: 'src-1',
            batch_id: 'batch-1',
            feishu_record_id: 'rec-1',
            conversation_id: 'conv-1',
            participant_name: 'Bob',
            total_turns: 3,
            avg_similarity_score: 75,
            min_similarity_score: 60,
            status: ConversationSourceStatus.COMPLETED,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        total: 1,
      });

      const result = await service.getConversationSources('batch-1', 1, 20);

      expect(conversationSnapshotRepository.findByBatchIdPaginated).toHaveBeenCalledWith(
        'batch-1',
        1,
        20,
        undefined,
      );
      expect(result.sources).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(20);
    });

    it('should pass status filter when provided', async () => {
      mockConversationSnapshotRepository.findByBatchIdPaginated.mockResolvedValue({
        data: [],
        total: 0,
      });

      await service.getConversationSources('batch-1', 1, 10, ConversationSourceStatus.COMPLETED);

      expect(conversationSnapshotRepository.findByBatchIdPaginated).toHaveBeenCalledWith(
        'batch-1',
        1,
        10,
        { status: ConversationSourceStatus.COMPLETED },
      );
    });
  });

  // ========== executeConversationBatch ==========

  describe('executeConversationBatch', () => {
    it('should throw error when batch has no sources', async () => {
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([]);

      await expect(service.executeConversationBatch('batch-empty')).rejects.toThrow(
        '没有回归验证记录',
      );
    });

    it('should execute all sources and return summary', async () => {
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([
        makeSource({ id: 'src-1' }),
        makeSource({ id: 'src-2' }),
      ]);
      mockConversationSnapshotRepository.findById.mockResolvedValue(makeSource());
      mockConversationSnapshotRepository.updateStatus.mockResolvedValue(undefined);
      mockConversationSnapshotRepository.updateSource.mockResolvedValue(undefined);
      mockParserService.splitIntoTurns.mockReturnValue([]);

      const result = await service.executeConversationBatch('batch-1');

      expect(result.batchId).toBe('batch-1');
      expect(result.total).toBe(2);
      expect(result.successCount + result.failedCount).toBe(2);
    });

    it('should count failures separately when some sources fail', async () => {
      mockConversationSnapshotRepository.findByBatchId.mockResolvedValue([
        makeSource({ id: 'src-ok' }),
        makeSource({ id: 'src-fail' }),
      ]);

      mockConversationSnapshotRepository.findById.mockImplementation((id: string) => {
        if (id === 'src-fail') {
          return Promise.reject(new Error('Database error'));
        }
        return Promise.resolve(makeSource({ id }));
      });
      mockConversationSnapshotRepository.updateStatus.mockResolvedValue(undefined);
      mockConversationSnapshotRepository.updateSource.mockResolvedValue(undefined);
      mockParserService.splitIntoTurns.mockReturnValue([]);

      const result = await service.executeConversationBatch('batch-1');

      expect(result.failedCount).toBeGreaterThan(0);
    });
  });

  // ========== updateTurnReview ==========

  describe('updateTurnReview', () => {
    it('should update execution review status', async () => {
      mockExecutionRepository.updateReview.mockResolvedValue(undefined);
      mockExecutionRepository.findById.mockResolvedValue({
        id: 'exec-1',
        conversation_snapshot_id: 'source-1',
        review_status: ReviewStatus.PASSED,
        review_comment: 'Looks good',
        failure_reason: null,
        reviewed_by: 'dashboard-user',
        reviewer_source: ReviewerSource.MANUAL,
        reviewed_at: new Date().toISOString(),
      } as any);
      mockConversationSnapshotRepository.findById.mockResolvedValue(makeSource());
      mockExecutionRepository.findByConversationSourceId.mockResolvedValue([
        {
          id: 'exec-1',
          turn_number: 1,
          review_status: ReviewStatus.PASSED,
          review_comment: 'Looks good',
          evaluation_reason: '自动评估良好',
        },
      ] as any);
      mockWriteBackService.writeBackSimilarityScore.mockResolvedValue({ success: true });

      const result = await service.updateTurnReview('exec-1', ReviewStatus.PASSED, 'Looks good');

      expect(executionRepository.updateReview).toHaveBeenCalledWith('exec-1', {
        reviewStatus: ReviewStatus.PASSED,
        reviewComment: 'Looks good',
        failureReason: undefined,
        reviewedBy: 'dashboard-user',
        reviewerSource: ReviewerSource.MANUAL,
      });
      expect(result).toEqual(
        expect.objectContaining({
          id: 'exec-1',
          reviewStatus: ReviewStatus.PASSED,
          reviewerSource: ReviewerSource.MANUAL,
        }),
      );
    });

    it('should update without comment when not provided', async () => {
      mockExecutionRepository.updateReview.mockResolvedValue(undefined);
      mockExecutionRepository.findById.mockResolvedValue({
        id: 'exec-1',
        conversation_snapshot_id: null,
        review_status: ReviewStatus.FAILED,
        review_comment: null,
        failure_reason: null,
        reviewed_by: 'dashboard-user',
        reviewer_source: ReviewerSource.MANUAL,
        reviewed_at: new Date().toISOString(),
      } as any);

      await service.updateTurnReview('exec-1', ReviewStatus.FAILED);

      expect(executionRepository.updateReview).toHaveBeenCalledWith('exec-1', {
        reviewStatus: ReviewStatus.FAILED,
        reviewComment: undefined,
        failureReason: undefined,
        reviewedBy: 'dashboard-user',
        reviewerSource: ReviewerSource.MANUAL,
      });
    });

    it('should write back manual review summary to validationSet when source exists', async () => {
      mockExecutionRepository.updateReview.mockResolvedValue(undefined);
      mockExecutionRepository.findById.mockResolvedValue({
        id: 'exec-1',
        conversation_snapshot_id: 'source-1',
        review_status: ReviewStatus.FAILED,
        review_comment: '岗位明显不匹配',
        failure_reason: '岗位明显不匹配',
        reviewed_by: 'claude-reviewer',
        reviewer_source: ReviewerSource.CLAUDE,
        reviewed_at: new Date().toISOString(),
      } as any);
      mockConversationSnapshotRepository.findById.mockResolvedValue(
        makeSource({
          avg_similarity_score: 71,
          min_similarity_score: 26,
          feishu_record_id: 'rec-001',
        }),
      );
      mockExecutionRepository.findByConversationSourceId.mockResolvedValue([
        {
          id: 'exec-1',
          turn_number: 1,
          review_status: ReviewStatus.FAILED,
          review_comment: '岗位明显不匹配',
          evaluation_reason: '自动评估判定偏差较大',
          reviewer_source: ReviewerSource.CLAUDE,
        },
      ] as any);
      mockWriteBackService.writeBackSimilarityScore.mockResolvedValue({ success: true });

      await service.updateTurnReview(
        'exec-1',
        ReviewStatus.FAILED,
        '岗位明显不匹配',
        ReviewerSource.CLAUDE,
        'claude-reviewer',
      );

      expect(writeBackService.writeBackSimilarityScore).toHaveBeenCalledWith(
        'rec-001',
        71,
        expect.objectContaining({
          batchId: 'batch-1',
          minSimilarityScore: 26,
          testStatus: FeishuTestStatus.FAILED,
          evaluationSummary: '评审摘要\n第1轮 失败（Claude）：岗位明显不匹配',
        }),
      );
    });

    it('should write back skipped when all turns are skipped', async () => {
      mockExecutionRepository.updateReview.mockResolvedValue(undefined);
      mockExecutionRepository.findById.mockResolvedValue({
        id: 'exec-1',
        conversation_snapshot_id: 'source-1',
        review_status: ReviewStatus.SKIPPED,
        review_comment: '本轮不评审',
        failure_reason: null,
        reviewed_by: 'dashboard-user',
        reviewer_source: ReviewerSource.MANUAL,
        reviewed_at: new Date().toISOString(),
      } as any);
      mockConversationSnapshotRepository.findById.mockResolvedValue(
        makeSource({
          avg_similarity_score: 71,
          min_similarity_score: 26,
          feishu_record_id: 'rec-001',
        }),
      );
      mockExecutionRepository.findByConversationSourceId.mockResolvedValue([
        {
          id: 'exec-1',
          turn_number: 1,
          review_status: ReviewStatus.SKIPPED,
          review_comment: '本轮不评审',
          evaluation_reason: '自动评估判定偏差较大',
          reviewer_source: ReviewerSource.MANUAL,
        },
        {
          id: 'exec-2',
          turn_number: 2,
          review_status: ReviewStatus.SKIPPED,
          review_comment: '本轮不评审',
          evaluation_reason: '自动评估判定偏差较大',
          reviewer_source: ReviewerSource.MANUAL,
        },
      ] as any);
      mockWriteBackService.writeBackSimilarityScore.mockResolvedValue({ success: true });

      await service.updateTurnReview(
        'exec-1',
        ReviewStatus.SKIPPED,
        '本轮不评审',
        ReviewerSource.MANUAL,
        'dashboard-user',
      );

      expect(writeBackService.writeBackSimilarityScore).toHaveBeenCalledWith(
        'rec-001',
        71,
        expect.objectContaining({
          testStatus: FeishuTestStatus.SKIPPED,
        }),
      );
    });
  });

  // ========== getSourceBatchId ==========

  describe('getSourceBatchId', () => {
    it('should return batch_id from source', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(
        makeSource({ batch_id: 'batch-x' }),
      );

      const result = await service.getSourceBatchId('source-1');

      expect(result).toBe('batch-x');
    });

    it('should return null when source not found', async () => {
      mockConversationSnapshotRepository.findById.mockResolvedValue(null);

      const result = await service.getSourceBatchId('non-existent');

      expect(result).toBeNull();
    });
  });
});
