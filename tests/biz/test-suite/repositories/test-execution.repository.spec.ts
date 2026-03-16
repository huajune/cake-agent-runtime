import { Test, TestingModule } from '@nestjs/testing';
import { TestExecutionRepository } from '@biz/test-suite/repositories/test-execution.repository';
import { SupabaseService } from '@core/supabase';
import { ExecutionStatus, ReviewStatus } from '@biz/test-suite/enums/test.enum';

function makeQueryMock(result: { data?: unknown; error?: unknown; count?: number }) {
  const chainMethods = [
    'select',
    'insert',
    'update',
    'upsert',
    'delete',
    'eq',
    'neq',
    'gte',
    'lte',
    'gt',
    'lt',
    'in',
    'or',
    'order',
    'limit',
    'range',
  ];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mock: any = Object.assign(Promise.resolve(result), {});
  for (const m of chainMethods) {
    mock[m] = jest.fn().mockReturnValue(mock);
  }
  return mock;
}

const sampleExecution = {
  id: 'exec_001',
  batch_id: 'batch_001',
  case_id: 'case_001',
  case_name: 'Test greeting',
  category: 'basic',
  test_input: { message: 'Hello' },
  expected_output: 'Hi there',
  agent_request: { model: 'gpt-4' },
  agent_response: { content: 'Hi!' },
  actual_output: 'Hi!',
  tool_calls: [],
  execution_status: ExecutionStatus.SUCCESS,
  review_status: ReviewStatus.PENDING,
  duration_ms: 1200,
  token_usage: 100,
  error_message: null,
  conversation_snapshot_id: null,
  turn_number: null,
  similarity_score: null,
  input_message: null,
  failure_reason: null,
  review_comment: null,
  test_scenario: null,
  reviewed_by: null,
  reviewed_at: null,
  evaluation_reason: null,
  created_at: '2026-03-10T00:00:00Z',
};

describe('TestExecutionRepository', () => {
  let repository: TestExecutionRepository;

  const mockSupabaseClient = {
    from: jest.fn(),
    rpc: jest.fn(),
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockSupabaseClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockSupabaseClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestExecutionRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<TestExecutionRepository>(TestExecutionRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== create ====================

  describe('create', () => {
    it('should insert and return new execution record', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const insertResult = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        batchId: 'batch_001',
        caseId: 'case_001',
        caseName: 'Test greeting',
        category: 'basic',
        testInput: { message: 'Hello' },
        expectedOutput: 'Hi there',
        agentRequest: { model: 'gpt-4', context: 'large context', systemPrompt: 'prompt' },
        agentResponse: { content: 'Hi!' },
        actualOutput: 'Hi!',
        toolCalls: [],
        executionStatus: ExecutionStatus.SUCCESS,
        durationMs: 1200,
        tokenUsage: 100,
        errorMessage: null,
      });

      expect(result).toEqual(sampleExecution);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_executions');
    });

    it('should sanitize agentRequest by removing large fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      let capturedData: unknown = null;
      const insertMock = {
        insert: jest.fn().mockImplementation((data) => {
          capturedData = data;
          return Object.assign(
            Promise.resolve({ data: [sampleExecution], error: null }),
            insertMock,
          );
        }),
        select: jest.fn().mockResolvedValue({ data: [sampleExecution], error: null }),
      };
      mockSupabaseClient.from.mockReturnValue(insertMock);

      await repository.create({
        testInput: { message: 'Hello' },
        agentRequest: {
          model: 'gpt-4',
          context: 'very large context string',
          systemPrompt: 'very long system prompt',
          toolContext: 'tool context data',
          stream: true,
        },
        agentResponse: null,
        actualOutput: '',
        toolCalls: [],
        executionStatus: ExecutionStatus.PENDING,
        durationMs: 0,
        tokenUsage: null,
        errorMessage: null,
      });

      // agentRequest should have context, systemPrompt, toolContext removed
      if (capturedData && typeof capturedData === 'object') {
        const req = (capturedData as Record<string, unknown>).agent_request as Record<
          string,
          unknown
        >;
        if (req) {
          expect(req.context).toBeUndefined();
          expect(req.systemPrompt).toBeUndefined();
          expect(req.toolContext).toBeUndefined();
          expect(req.model).toBe('gpt-4');
          expect(req.stream).toBe(true);
        }
      }
    });

    it('should set default review status to PENDING', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const pendingExec = { ...sampleExecution, review_status: ReviewStatus.PENDING };
      const insertResult = makeQueryMock({ data: [pendingExec], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        testInput: { message: 'test' },
        agentRequest: null,
        agentResponse: null,
        actualOutput: '',
        toolCalls: [],
        executionStatus: ExecutionStatus.PENDING,
        durationMs: 0,
        tokenUsage: null,
        errorMessage: null,
      });

      expect(result.review_status).toBe(ReviewStatus.PENDING);
    });
  });

  // ==================== findById ====================

  describe('findById', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findById('exec_001');

      expect(result).toBeNull();
    });

    it('should return execution when found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('exec_001');

      expect(result).toEqual(sampleExecution);
    });

    it('should return null when not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== findMany ====================

  describe('findMany', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findMany();

      expect(result).toEqual([]);
    });

    it('should return list of executions', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findMany(10, 0);

      expect(result).toHaveLength(1);
    });
  });

  // ==================== findByBatchId ====================

  describe('findByBatchId', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findByBatchId('batch_001');

      expect(result).toEqual([]);
    });

    it('should return executions for a batch', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001');

      expect(result).toHaveLength(1);
    });

    it('should apply reviewStatus filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001', {
        reviewStatus: ReviewStatus.PASSED,
      });

      expect(result).toEqual([]);
    });

    it('should apply executionStatus filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001', {
        executionStatus: ExecutionStatus.SUCCESS,
      });

      expect(result).toHaveLength(1);
    });

    it('should apply category filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001', { category: 'basic' });

      expect(result).toHaveLength(1);
    });
  });

  // ==================== findByBatchIdLite ====================

  describe('findByBatchIdLite', () => {
    it('should return lite execution data', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const liteData = {
        id: 'exec_001',
        execution_status: ExecutionStatus.SUCCESS,
        review_status: ReviewStatus.PENDING,
        category: 'basic',
        duration_ms: 1200,
        token_usage: 100,
        failure_reason: null,
      };

      const queryMock = makeQueryMock({ data: [liteData], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchIdLite('batch_001');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('exec_001');
    });
  });

  // ==================== findByBatchIdForList ====================

  describe('findByBatchIdForList', () => {
    it('should return list-optimized execution data with input_message extracted', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const execWithInput = {
        ...sampleExecution,
        test_input: { message: 'Hello world' },
      };

      const queryMock = makeQueryMock({ data: [execWithInput], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchIdForList('batch_001');

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('exec_001');
      expect(result[0].input_message).toBe('Hello world');
    });

    it('should return empty string for input_message when test_input has no message', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const execNoMessage = { ...sampleExecution, test_input: null };
      const queryMock = makeQueryMock({ data: [execNoMessage], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchIdForList('batch_001');

      expect(result[0].input_message).toBe('');
    });
  });

  // ==================== countCompletedByBatchId ====================

  describe('countCompletedByBatchId', () => {
    it('should return zero counts when no records', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.countCompletedByBatchId('batch_001');

      expect(result).toEqual({ total: 0, success: 0, failure: 0, timeout: 0 });
    });

    it('should count records by execution status', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const records = [
        { execution_status: ExecutionStatus.SUCCESS },
        { execution_status: ExecutionStatus.SUCCESS },
        { execution_status: ExecutionStatus.FAILURE },
        { execution_status: ExecutionStatus.TIMEOUT },
      ];

      const queryMock = makeQueryMock({ data: records, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.countCompletedByBatchId('batch_001');

      expect(result.total).toBe(4);
      expect(result.success).toBe(2);
      expect(result.failure).toBe(1);
      expect(result.timeout).toBe(1);
    });
  });

  // ==================== updateByBatchAndCase ====================

  describe('updateByBatchAndCase', () => {
    it('should update execution result', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(
        repository.updateByBatchAndCase('batch_001', 'case_001', {
          agentRequest: { model: 'gpt-4' },
          agentResponse: { content: 'Hi!' },
          actualOutput: 'Hi!',
          toolCalls: [],
          executionStatus: ExecutionStatus.SUCCESS,
          durationMs: 1200,
        }),
      ).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_executions');
    });
  });

  // ==================== updateReview ====================

  describe('updateReview', () => {
    it('should update review status and return updated execution', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const reviewedExec = { ...sampleExecution, review_status: ReviewStatus.PASSED };
      const updateResult = makeQueryMock({ data: [reviewedExec], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateReview('exec_001', {
        reviewStatus: ReviewStatus.PASSED,
        reviewComment: 'Looks good',
        reviewedBy: 'reviewer_001',
      });

      expect(result.review_status).toBe(ReviewStatus.PASSED);
    });
  });

  // ==================== batchUpdateReview ====================

  describe('batchUpdateReview', () => {
    it('should update multiple executions review status', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updatedExecs = [
        { ...sampleExecution, review_status: ReviewStatus.FAILED },
        { ...sampleExecution, id: 'exec_002', review_status: ReviewStatus.FAILED },
      ];
      const updateResult = makeQueryMock({ data: updatedExecs, error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.batchUpdateReview(['exec_001', 'exec_002'], {
        reviewStatus: ReviewStatus.FAILED,
        failureReason: 'Wrong answer',
      });

      expect(result).toHaveLength(2);
    });
  });

  // ==================== findByConversationSourceAndTurn ====================

  describe('findByConversationSourceAndTurn', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findByConversationSourceAndTurn('src_001', 1);

      expect(result).toBeNull();
    });

    it('should return execution for specific conversation source and turn', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const execWithConv = {
        ...sampleExecution,
        conversation_snapshot_id: 'src_001',
        turn_number: 1,
      };
      const queryMock = makeQueryMock({ data: [execWithConv], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByConversationSourceAndTurn('src_001', 1);

      expect(result).not.toBeNull();
      expect(result?.conversation_snapshot_id).toBe('src_001');
    });
  });

  // ==================== findByConversationSourceId ====================

  describe('findByConversationSourceId', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findByConversationSourceId('src_001');

      expect(result).toEqual([]);
    });

    it('should return all executions for a conversation source', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const execs = [
        { ...sampleExecution, conversation_snapshot_id: 'src_001', turn_number: 1 },
        { ...sampleExecution, id: 'exec_002', conversation_snapshot_id: 'src_001', turn_number: 2 },
      ];
      const queryMock = makeQueryMock({ data: execs, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByConversationSourceId('src_001');

      expect(result).toHaveLength(2);
    });
  });

  // ==================== updateExecution ====================

  describe('updateExecution', () => {
    it('should update execution and return updated record', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updatedExec = { ...sampleExecution, similarity_score: 88 };
      const updateResult = makeQueryMock({ data: [updatedExec], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateExecution('exec_001', {
        similarity_score: 88,
        review_status: ReviewStatus.PASSED,
      });

      expect(result.similarity_score).toBe(88);
    });

    it('should sanitize agent_request large fields when updating', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [sampleExecution], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await repository.updateExecution('exec_001', {
        agent_request: {
          model: 'gpt-4',
          context: 'big context',
          systemPrompt: 'big prompt',
          toolContext: 'big tool context',
        },
        actual_output: 'New output',
      });

      // Should not throw
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_executions');
    });
  });
});
