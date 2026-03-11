import { Injectable } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { BaseRepository } from './base.repository';
import { SupabaseService } from './supabase.service';

// Concrete subclass to test the abstract BaseRepository
@Injectable()
class TestRepository extends BaseRepository {
  protected readonly tableName = 'test_table';

  constructor(supabaseService: SupabaseService) {
    super(supabaseService);
  }

  // Expose protected methods for testing
  async testSelect<T>(columns?: string, modifier?: (q: unknown) => unknown): Promise<T[]> {
    return this.select<T>(columns, modifier as Parameters<typeof this.select>[1]);
  }

  async testSelectOne<T>(columns?: string, modifier?: (q: unknown) => unknown): Promise<T | null> {
    return this.selectOne<T>(columns, modifier as Parameters<typeof this.selectOne>[1]);
  }

  async testInsert<T>(
    data: Partial<T>,
    options?: Parameters<typeof this.insert>[1],
  ): Promise<T | null> {
    return this.insert<T>(data, options);
  }

  async testInsertBatch<T>(data: Partial<T>[]): Promise<number> {
    return this.insertBatch<T>(data);
  }

  async testUpdate<T>(data: Partial<T>, modifier: (q: unknown) => unknown): Promise<T[]> {
    return this.update<T>(data, modifier as Parameters<typeof this.update>[1]);
  }

  async testUpsert<T>(
    data: Partial<T>,
    options?: Parameters<typeof this.upsert>[1],
  ): Promise<T | null> {
    return this.upsert<T>(data, options);
  }

  async testUpsertBatch<T>(
    data: Partial<T>[],
    options?: Parameters<typeof this.upsertBatch>[1],
  ): Promise<number> {
    return this.upsertBatch<T>(data, options);
  }

  async testDelete<T>(modifier: (q: unknown) => unknown, returnDeleted?: boolean): Promise<T[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.delete<T>(modifier as any, returnDeleted);
  }

  async testRpc<T>(functionName: string, params?: Record<string, unknown>): Promise<T | null> {
    return this.rpc<T>(functionName, params);
  }

  async testCount(modifier?: (q: unknown) => unknown): Promise<number> {
    return this.count(modifier as Parameters<typeof this.count>[0]);
  }

  testMapRpcRow<T>(
    row: Record<string, unknown>,
    mapping: Record<string, { field: string; type: 'int' | 'float' | 'string' }>,
  ): T {
    return this.mapRpcRow<T>(row, mapping);
  }

  testIsConflictError(error: unknown): boolean {
    return this.isConflictError(error);
  }

  testIsNotFoundError(error: unknown): boolean {
    return this.isNotFoundError(error);
  }

  testIsAvailable(): boolean {
    return this.isAvailable();
  }
}

describe('BaseRepository', () => {
  let repository: TestRepository;

  // Chainable mock builder
  const _buildQueryChain = (result: { data?: unknown; error?: unknown; count?: number }) => {
    const chain: Record<string, jest.Mock> = {};
    const _chainFn = () => chain;

    const methods = [
      'select',
      'insert',
      'update',
      'upsert',
      'delete',
      'eq',
      'neq',
      'gt',
      'gte',
      'lt',
      'lte',
      'in',
      'or',
      'order',
      'limit',
      'range',
      'head',
    ];

    for (const method of methods) {
      chain[method] = jest.fn().mockReturnValue(chain);
    }

    // Terminal mock that resolves the promise
    chain['then'] = jest
      .fn()
      .mockImplementation((resolve) => Promise.resolve(result).then(resolve));

    // Make the chain itself a thenable
    Object.assign(chain, result);
    for (const method of methods) {
      (chain[method] as jest.Mock).mockReturnValue(
        new Proxy(chain, {
          get: (target, prop) => {
            if (prop === 'then') {
              return (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
            }
            return target[prop as string];
          },
        }),
      );
    }

    return chain;
  };

  const mockFrom = jest.fn();
  const mockRpc = jest.fn();

  const mockClient = {
    from: mockFrom,
    rpc: mockRpc,
  };

  const mockSupabaseService = {
    getSupabaseClient: jest.fn().mockReturnValue(mockClient),
    isClientInitialized: jest.fn().mockReturnValue(true),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockSupabaseService.getSupabaseClient.mockReturnValue(mockClient);
    mockSupabaseService.isClientInitialized.mockReturnValue(true);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        TestRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<TestRepository>(TestRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== isAvailable ====================

  describe('isAvailable', () => {
    it('should return true when client is initialized', () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      expect(repository.testIsAvailable()).toBe(true);
    });

    it('should return false when client is not initialized', () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);
      expect(repository.testIsAvailable()).toBe(false);
    });
  });

  // ==================== select ====================

  describe('select', () => {
    it('should return data when query succeeds', async () => {
      const records = [{ id: '1', name: 'test' }];
      const chainMock = {
        select: jest.fn().mockReturnThis(),
        eq: jest.fn().mockReturnThis(),
        order: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        then: jest.fn(),
      };

      // Make the chain awaitable
      const thenable = { data: records, error: null };
      chainMock.select.mockReturnValue(Object.assign(chainMock, thenable));
      mockFrom.mockReturnValue(chainMock);
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      // Use a simple approach: spy on select internals
      // We'll test with a direct mock approach
      const mockQuery = {
        data: records,
        error: null,
      };

      mockFrom.mockReturnValue({
        select: jest.fn().mockResolvedValue(mockQuery),
      });

      const result = await repository.testSelect('*');
      expect(result).toEqual(records);
    });

    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.testSelect('*');
      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockFrom.mockReturnValue({
        select: jest
          .fn()
          .mockResolvedValue({ data: null, error: { message: 'DB error', code: '42P01' } }),
      });

      const result = await repository.testSelect('*');
      expect(result).toEqual([]);
    });
  });

  // ==================== isConflictError ====================

  describe('isConflictError', () => {
    it('should return true for unique_violation error (code 23505)', () => {
      expect(repository.testIsConflictError({ code: '23505' })).toBe(true);
    });

    it('should return false for other error codes', () => {
      expect(repository.testIsConflictError({ code: '42P01' })).toBe(false);
      expect(repository.testIsConflictError({ code: 'PGRST116' })).toBe(false);
      expect(repository.testIsConflictError({})).toBe(false);
    });
  });

  // ==================== isNotFoundError ====================

  describe('isNotFoundError', () => {
    it('should return true for PGRST116 error', () => {
      expect(repository.testIsNotFoundError({ code: 'PGRST116' })).toBe(true);
    });

    it('should return true for 42883 error (function not found)', () => {
      expect(repository.testIsNotFoundError({ code: '42883' })).toBe(true);
    });

    it('should return false for other error codes', () => {
      expect(repository.testIsNotFoundError({ code: '23505' })).toBe(false);
      expect(repository.testIsNotFoundError({})).toBe(false);
    });
  });

  // ==================== mapRpcRow ====================

  describe('mapRpcRow', () => {
    it('should map int fields correctly', () => {
      const row = { total_count: '42', rate: '0.85', label: 'test' };
      const mapping = {
        totalCount: { field: 'total_count', type: 'int' as const },
        rate: { field: 'rate', type: 'float' as const },
        label: { field: 'label', type: 'string' as const },
      };

      const result = repository.testMapRpcRow<{
        totalCount: number;
        rate: number;
        label: string;
      }>(row, mapping);

      expect(result.totalCount).toBe(42);
      expect(result.rate).toBeCloseTo(0.85);
      expect(result.label).toBe('test');
    });

    it('should default to 0 for missing numeric fields', () => {
      const row = {};
      const mapping = {
        count: { field: 'count', type: 'int' as const },
        score: { field: 'score', type: 'float' as const },
      };

      const result = repository.testMapRpcRow<{ count: number; score: number }>(row, mapping);

      expect(result.count).toBe(0);
      expect(result.score).toBe(0);
    });

    it('should default to empty string for missing string fields', () => {
      const row = {};
      const mapping = {
        name: { field: 'name', type: 'string' as const },
      };

      const result = repository.testMapRpcRow<{ name: string }>(row, mapping);
      expect(result.name).toBe('');
    });
  });
});
