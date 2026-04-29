import { Test, TestingModule } from '@nestjs/testing';
import { ConversationSnapshotRepository } from '@biz/test-suite/repositories/conversation-snapshot.repository';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ConversationSourceStatus } from '@biz/test-suite/enums/test.enum';

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

const sampleSource = {
  id: 'src_001',
  batch_id: 'batch_001',
  feishu_record_id: 'feishu_001',
  conversation_id: 'conv_001',
  validation_title: '验证标题',
  participant_name: 'Alice',
  full_conversation: [{ role: 'user', content: 'Hello' }],
  raw_text: 'Alice: Hello',
  total_turns: 3,
  status: ConversationSourceStatus.PENDING,
  avg_similarity_score: null,
  min_similarity_score: null,
  created_at: '2026-03-10T00:00:00Z',
  updated_at: '2026-03-10T00:00:00Z',
};

describe('ConversationSnapshotRepository', () => {
  let repository: ConversationSnapshotRepository;

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
        ConversationSnapshotRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<ConversationSnapshotRepository>(ConversationSnapshotRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== create ====================

  describe('create', () => {
    it('should insert and return new conversation source', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const insertResult = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        batchId: 'batch_001',
        feishuRecordId: 'feishu_001',
        conversationId: 'conv_001',
        validationTitle: '验证标题',
        participantName: 'Alice',
        fullConversation: [{ role: 'user', content: 'Hello' }],
        rawText: 'Alice: Hello',
        totalTurns: 3,
      });

      expect(result).toEqual(sampleSource);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_conversation_snapshots');
    });

    it('should set status to PENDING on create', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const insertResult = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        batchId: 'batch_001',
        feishuRecordId: 'feishu_001',
        conversationId: 'conv_001',
        fullConversation: [],
        totalTurns: 0,
      });

      expect(result.status).toBe(ConversationSourceStatus.PENDING);
    });

    it('should handle optional participantName as null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const sourceWithoutName = { ...sampleSource, participant_name: null };
      const insertResult = makeQueryMock({ data: [sourceWithoutName], error: null });
      mockSupabaseClient.from.mockReturnValue(insertResult);

      const result = await repository.create({
        batchId: 'batch_001',
        feishuRecordId: 'feishu_001',
        conversationId: 'conv_001',
        fullConversation: [],
        totalTurns: 0,
      });

      expect(result.participant_name).toBeNull();
    });

    it('should fall back when validation_title column is missing', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const missingColumnResult = makeQueryMock({
        data: null,
        error: {
          code: 'PGRST204',
          message:
            "Could not find the 'validation_title' column of 'test_conversation_snapshots' in the schema cache",
        },
      });
      const fallbackSource = { ...sampleSource, validation_title: null };
      const fallbackResult = makeQueryMock({ data: [fallbackSource], error: null });
      mockSupabaseClient.from
        .mockReturnValueOnce(missingColumnResult)
        .mockReturnValueOnce(fallbackResult);

      const result = await repository.create({
        batchId: 'batch_001',
        feishuRecordId: 'feishu_001',
        conversationId: 'conv_001',
        validationTitle: '验证标题',
        participantName: 'Alice',
        fullConversation: [{ role: 'user', content: 'Hello' }],
        rawText: 'Alice: Hello',
        totalTurns: 3,
      });

      expect(result).toEqual(fallbackSource);
      expect(missingColumnResult.insert).toHaveBeenCalledWith(
        expect.objectContaining({ validation_title: '验证标题' }),
      );
      expect(fallbackResult.insert).toHaveBeenCalledWith(
        expect.not.objectContaining({ validation_title: expect.anything() }),
      );
    });

    it('should skip validation_title after detecting an old schema', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const missingColumnResult = makeQueryMock({
        data: null,
        error: {
          code: 'PGRST204',
          message:
            "Could not find the 'validation_title' column of 'test_conversation_snapshots' in the schema cache",
        },
      });
      const fallbackResult = makeQueryMock({ data: [sampleSource], error: null });
      const secondInsertResult = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from
        .mockReturnValueOnce(missingColumnResult)
        .mockReturnValueOnce(fallbackResult)
        .mockReturnValueOnce(secondInsertResult);

      await repository.create({
        batchId: 'batch_001',
        feishuRecordId: 'feishu_001',
        conversationId: 'conv_001',
        validationTitle: '验证标题',
        fullConversation: [],
        totalTurns: 0,
      });

      await repository.create({
        batchId: 'batch_002',
        feishuRecordId: 'feishu_002',
        conversationId: 'conv_002',
        validationTitle: '另一个标题',
        fullConversation: [],
        totalTurns: 0,
      });

      expect(secondInsertResult.insert).toHaveBeenCalledWith(
        expect.not.objectContaining({ validation_title: expect.anything() }),
      );
    });
  });

  // ==================== findById ====================

  describe('findById', () => {
    it('should return null when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findById('src_001');

      expect(result).toBeNull();
    });

    it('should return source when found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('src_001');

      expect(result).toEqual(sampleSource);
    });

    it('should return null when not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findById('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== findByBatchId ====================

  describe('findByBatchId', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.findByBatchId('batch_001');

      expect(result).toEqual([]);
    });

    it('should return sources for a batch', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const sources = [
        sampleSource,
        { ...sampleSource, id: 'src_002', conversation_id: 'conv_002' },
      ];
      const queryMock = makeQueryMock({ data: sources, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001');

      expect(result).toHaveLength(2);
    });

    it('should apply status filter when provided', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001', {
        status: ConversationSourceStatus.PENDING,
      });

      expect(result).toHaveLength(1);
    });

    it('should return all sources without filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchId('batch_001');

      expect(result).toHaveLength(1);
    });
  });

  // ==================== findByBatchIdPaginated ====================

  describe('findByBatchIdPaginated', () => {
    it('should return paginated data and total', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleSource], error: null, count: 1 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchIdPaginated('batch_001', 1, 10);

      expect(result.data).toHaveLength(1);
      expect(typeof result.total).toBe('number');
    });

    it('should apply status filter in paginated query', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null, count: 0 });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByBatchIdPaginated('batch_001', 1, 10, {
        status: ConversationSourceStatus.COMPLETED,
      });

      expect(result.data).toEqual([]);
    });
  });

  // ==================== findByConversationId ====================

  describe('findByConversationId', () => {
    it('should return source when found by conversationId', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByConversationId('conv_001');

      expect(result).toEqual(sampleSource);
    });

    it('should return null when not found', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.findByConversationId('nonexistent');

      expect(result).toBeNull();
    });
  });

  // ==================== updateSource ====================

  describe('updateSource', () => {
    it('should return updated source', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updated = {
        ...sampleSource,
        status: ConversationSourceStatus.COMPLETED,
        avg_similarity_score: 85,
      };
      const updateResult = makeQueryMock({ data: [updated], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateSource('src_001', {
        status: ConversationSourceStatus.COMPLETED,
        avgSimilarityScore: 85,
      });

      expect(result.status).toBe(ConversationSourceStatus.COMPLETED);
      expect(result.avg_similarity_score).toBe(85);
    });

    it('should handle partial update data', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updated = { ...sampleSource, status: ConversationSourceStatus.RUNNING };
      const updateResult = makeQueryMock({ data: [updated], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      const result = await repository.updateSource('src_001', {
        status: ConversationSourceStatus.RUNNING,
      });

      expect(result.status).toBe(ConversationSourceStatus.RUNNING);
    });
  });

  // ==================== updateStatus ====================

  describe('updateStatus', () => {
    it('should update status without returning data', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const updateResult = makeQueryMock({ data: [sampleSource], error: null });
      mockSupabaseClient.from.mockReturnValue(updateResult);

      await expect(
        repository.updateStatus('src_001', ConversationSourceStatus.RUNNING),
      ).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('test_conversation_snapshots');
    });
  });

  // ==================== countByBatchIdGroupByStatus ====================

  describe('countByBatchIdGroupByStatus', () => {
    it('should return status counts grouped correctly', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const records = [
        { status: ConversationSourceStatus.PENDING },
        { status: ConversationSourceStatus.PENDING },
        { status: ConversationSourceStatus.RUNNING },
        { status: ConversationSourceStatus.COMPLETED },
        { status: ConversationSourceStatus.COMPLETED },
        { status: ConversationSourceStatus.COMPLETED },
        { status: ConversationSourceStatus.FAILED },
      ];

      const queryMock = makeQueryMock({ data: records, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.countByBatchIdGroupByStatus('batch_001');

      expect(result.total).toBe(7);
      expect(result.pending).toBe(2);
      expect(result.running).toBe(1);
      expect(result.completed).toBe(3);
      expect(result.failed).toBe(1);
    });

    it('should return all zeros when no records', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.countByBatchIdGroupByStatus('batch_001');

      expect(result).toEqual({ total: 0, pending: 0, running: 0, completed: 0, failed: 0 });
    });
  });

  // ==================== calculateBatchAvgSimilarity ====================

  describe('calculateBatchAvgSimilarity', () => {
    it('should return null when no completed records', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.calculateBatchAvgSimilarity('batch_001');

      expect(result).toBeNull();
    });

    it('should calculate average of valid similarity scores', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const records = [
        { avg_similarity_score: 80 },
        { avg_similarity_score: 90 },
        { avg_similarity_score: 70 },
        { avg_similarity_score: null }, // Should be ignored
      ];

      const queryMock = makeQueryMock({ data: records, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.calculateBatchAvgSimilarity('batch_001');

      expect(result).toBe(80); // round((80+90+70)/3) = round(80) = 80
    });

    it('should return null when all scores are null', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const records = [{ avg_similarity_score: null }, { avg_similarity_score: null }];

      const queryMock = makeQueryMock({ data: records, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.calculateBatchAvgSimilarity('batch_001');

      expect(result).toBeNull();
    });
  });
});
