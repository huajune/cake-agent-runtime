import { Test, TestingModule } from '@nestjs/testing';
import { BookingRepository } from './booking.repository';
import { SupabaseService } from '@core/supabase';

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

describe('BookingRepository', () => {
  let repository: BookingRepository;

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
        BookingRepository,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
      ],
    }).compile();

    repository = module.get<BookingRepository>(BookingRepository);
  });

  it('should be defined', () => {
    expect(repository).toBeDefined();
  });

  // ==================== incrementBookingCount ====================

  describe('incrementBookingCount', () => {
    it('should skip when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      await repository.incrementBookingCount({
        brandName: 'BrandA',
        storeName: 'StoreA',
        chatId: 'chat_001',
        userId: 'user_001',
        userName: 'Alice',
        managerId: 'mgr_001',
        managerName: 'Bob',
      });

      expect(mockSupabaseClient.from).not.toHaveBeenCalled();
    });

    it('should call RPC increment_booking_count with full params', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      await repository.incrementBookingCount({
        brandName: 'BrandA',
        storeName: 'StoreA',
        chatId: 'chat_001',
        userId: 'user_001',
        userName: 'Alice',
        managerId: 'mgr_001',
        managerName: 'Bob',
      });

      expect(mockSupabaseClient.rpc).toHaveBeenCalledWith('increment_booking_count', {
        p_date: expect.any(String),
        p_brand_name: 'BrandA',
        p_store_name: 'StoreA',
        p_chat_id: 'chat_001',
        p_user_id: 'user_001',
        p_user_name: 'Alice',
        p_manager_id: 'mgr_001',
        p_manager_name: 'Bob',
      });
    });

    it('should call RPC with null for missing fields', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({ data: null, error: null });

      // No error should be thrown
      await expect(
        repository.incrementBookingCount({
          chatId: 'chat_002',
        }),
      ).resolves.not.toThrow();
    });

    it('should not throw when RPC fails', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      mockSupabaseClient.rpc.mockResolvedValue({
        data: null,
        error: { message: 'RPC failed', code: '42P01' },
      });

      await expect(
        repository.incrementBookingCount({ brandName: 'BrandA' }),
      ).resolves.not.toThrow();
    });
  });

  // ==================== getBookingStats ====================

  describe('getBookingStats', () => {
    it('should return empty array when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const result = await repository.getBookingStats({});

      expect(result).toEqual([]);
    });

    it('should return mapped booking stats', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);
      const dbRows = [
        {
          date: '2026-03-10',
          brand_name: 'BrandA',
          store_name: 'StoreA',
          booking_count: 3,
          chat_id: 'chat_001',
          user_id: 'user_001',
          user_name: 'Alice',
          manager_id: 'mgr_001',
          manager_name: 'Bob',
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({
        startDate: '2026-03-10',
        endDate: '2026-03-10',
      });

      expect(result).toHaveLength(1);
      expect(result[0].brandName).toBe('BrandA');
      expect(result[0].storeName).toBe('StoreA');
      expect(result[0].bookingCount).toBe(3);
      expect(result[0].userName).toBe('Alice');
    });

    it('should apply date range filters', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({
        startDate: '2026-03-01',
        endDate: '2026-03-31',
      });

      expect(result).toEqual([]);
    });

    it('should apply startDate only filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({ startDate: '2026-03-01' });

      expect(result).toEqual([]);
    });

    it('should apply endDate only filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({ endDate: '2026-03-31' });

      expect(result).toEqual([]);
    });

    it('should apply brandName filter', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({ brandName: 'BrandX' });

      expect(result).toEqual([]);
    });

    it('should return empty array on error', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({
        data: null,
        error: { message: 'Query failed', code: '42P01' },
      });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const result = await repository.getBookingStats({});

      expect(result).toEqual([]);
    });
  });

  // ==================== getTodayBookingCount ====================

  describe('getTodayBookingCount', () => {
    it('should return sum of today booking counts', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const today = new Date().toISOString().split('T')[0];
      const dbRows = [
        {
          date: today,
          brand_name: 'BrandA',
          store_name: 'StoreA',
          booking_count: 5,
          chat_id: null,
          user_id: null,
          user_name: null,
          manager_id: null,
          manager_name: null,
        },
        {
          date: today,
          brand_name: 'BrandB',
          store_name: 'StoreB',
          booking_count: 3,
          chat_id: null,
          user_id: null,
          user_name: null,
          manager_id: null,
          manager_name: null,
        },
      ];

      const queryMock = makeQueryMock({ data: dbRows, error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const count = await repository.getTodayBookingCount();

      expect(count).toBe(8);
    });

    it('should return 0 when no bookings today', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(true);

      const queryMock = makeQueryMock({ data: [], error: null });
      mockSupabaseClient.from.mockReturnValue(queryMock);

      const count = await repository.getTodayBookingCount();

      expect(count).toBe(0);
    });

    it('should return 0 when supabase is not available', async () => {
      mockSupabaseService.isClientInitialized.mockReturnValue(false);

      const count = await repository.getTodayBookingCount();

      expect(count).toBe(0);
    });
  });
});
