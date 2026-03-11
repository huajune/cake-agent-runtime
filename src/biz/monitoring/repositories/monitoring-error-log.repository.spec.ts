import { Test, TestingModule } from '@nestjs/testing';
import { MonitoringErrorLogRepository } from './monitoring-error-log.repository';
import { SupabaseService } from '@core/supabase';
type AlertErrorType = 'agent' | 'message' | 'delivery' | 'system' | 'merge' | 'unknown';
const AlertErrorType = {
  AI_TIMEOUT: 'agent' as AlertErrorType,
  MESSAGE_ERROR: 'message' as AlertErrorType,
};

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

describe('MonitoringErrorLogRepository', () => {
  let repository: MonitoringErrorLogRepository;

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
        MonitoringErrorLogRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<MonitoringErrorLogRepository>(MonitoringErrorLogRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== saveErrorLog ====================

  describe('saveErrorLog', () => {
    it('should upsert error log record', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      await repository.saveErrorLog({
        messageId: 'msg_001',
        timestamp: Date.now(),
        error: 'Something failed',
        alertType: AlertErrorType.AI_TIMEOUT,
      });

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_error_logs');
    });

    it('should save log without alertType', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      await expect(
        repository.saveErrorLog({
          messageId: 'msg_002',
          timestamp: Date.now(),
          error: 'Another error',
        }),
      ).resolves.not.toThrow();
    });
  });

  // ==================== saveErrorLogsBatch ====================

  describe('saveErrorLogsBatch', () => {
    it('should skip empty array', async () => {
      await repository.saveErrorLogsBatch([]);

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should upsert batch of error logs', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const upsertResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(upsertResult);

      const logs = [
        { messageId: 'msg_001', timestamp: Date.now(), error: 'Error 1' },
        { messageId: 'msg_002', timestamp: Date.now(), error: 'Error 2' },
      ];

      await expect(repository.saveErrorLogsBatch(logs)).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_error_logs');
    });

    it('should handle null or undefined input gracefully', async () => {
      await expect(repository.saveErrorLogsBatch(null as unknown as [])).resolves.not.toThrow();
    });
  });

  // ==================== getRecentErrors ====================

  describe('getRecentErrors', () => {
    it('should return recent error logs with default limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const dbRows = [
        {
          message_id: 'msg_001',
          timestamp: 1700000000000,
          error: 'Timeout occurred',
          alert_type: AlertErrorType.AI_TIMEOUT,
        },
        {
          message_id: 'msg_002',
          timestamp: 1700000001000,
          error: 'API error',
          alert_type: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentErrors();

      expect(result).toHaveLength(2);
      expect(result[0].messageId).toBe('msg_001');
      expect(result[0].error).toBe('Timeout occurred');
      expect(result[0].alertType).toBe(AlertErrorType.AI_TIMEOUT);
      expect(typeof result[0].timestamp).toBe('number');
    });

    it('should respect custom limit', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentErrors(5);

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'DB error', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getRecentErrors();

      expect(result).toEqual([]);
    });
  });

  // ==================== getErrorLogsSince ====================

  describe('getErrorLogsSince', () => {
    it('should return error logs since cutoff timestamp', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const cutoff = Date.now() - 3600000;
      const dbRows = [
        {
          message_id: 'msg_003',
          timestamp: Date.now(),
          error: 'Recent error',
          alert_type: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getErrorLogsSince(cutoff);

      expect(result).toHaveLength(1);
      expect(result[0].messageId).toBe('msg_003');
    });

    it('should return empty array when no errors since cutoff', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getErrorLogsSince(Date.now());

      expect(result).toEqual([]);
    });
  });

  // ==================== cleanupErrorLogs ====================

  describe('cleanupErrorLogs', () => {
    it('should delete old logs and return count', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deletedRows = [
        { message_id: 'old_001', timestamp: 1000, error: 'old' },
        { message_id: 'old_002', timestamp: 2000, error: 'old too' },
      ];

      const deleteResult = makeQueryMock({ data: deletedRows, error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      const count = await repository.cleanupErrorLogs(30);

      expect(count).toBe(2);
    });

    it('should return 0 when no old logs exist', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deleteResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      const count = await repository.cleanupErrorLogs(30);

      expect(count).toBe(0);
    });

    it('should use default retentionDays of 30', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deleteResult = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      const count = await repository.cleanupErrorLogs();

      expect(count).toBe(0);
      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_error_logs');
    });
  });

  // ==================== clearAllRecords ====================

  describe('clearAllRecords', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.clearAllRecords();

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should delete all records when supabase is available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const deleteResult = makeQueryMock({ data: null, error: null });
      mockSupabaseClient.from.mockReturnValue(deleteResult);

      await expect(repository.clearAllRecords()).resolves.not.toThrow();

      expect(mockSupabaseClient.from).toHaveBeenCalledWith('monitoring_error_logs');
    });
  });
});
