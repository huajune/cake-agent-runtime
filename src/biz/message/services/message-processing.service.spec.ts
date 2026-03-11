import { Test, TestingModule } from '@nestjs/testing';
import { MessageProcessingService } from './message-processing.service';
import { MessageProcessingRepository } from '../repositories/message-processing.repository';

describe('MessageProcessingService', () => {
  let service: MessageProcessingService;

  const mockMessageProcessingRepository = {
    getMessageStats: jest.fn(),
    getSlowestMessages: jest.fn(),
    getMessageProcessingRecords: jest.fn(),
    getMessageProcessingRecordById: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageProcessingService,
        {
          provide: MessageProcessingRepository,
          useValue: mockMessageProcessingRepository,
        },
      ],
    }).compile();

    service = module.get<MessageProcessingService>(MessageProcessingService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getMessageStats ====================

  describe('getMessageStats', () => {
    it('should call repository with correct timestamp range for given dates', async () => {
      const mockStats = { total: 100, success: 90, failure: 10 };
      mockMessageProcessingRepository.getMessageStats.mockResolvedValue(mockStats);

      const result = await service.getMessageStats('2024-01-01', '2024-01-31');

      expect(result).toEqual(mockStats);
      expect(mockMessageProcessingRepository.getMessageStats).toHaveBeenCalledTimes(1);

      const [startTime, endTime] = mockMessageProcessingRepository.getMessageStats.mock.calls[0];
      // startTime should be beginning of 2024-01-01
      expect(new Date(startTime).getDate()).toBe(1);
      expect(new Date(startTime).getHours()).toBe(0);
      // endTime should be end of 2024-01-31 (23:59:59)
      expect(new Date(endTime).getHours()).toBe(23);
    });

    it('should use default range (now minus 1 day) when no dates provided', async () => {
      const mockStats = { total: 50 };
      mockMessageProcessingRepository.getMessageStats.mockResolvedValue(mockStats);

      const beforeCall = Date.now();
      const result = await service.getMessageStats();
      const afterCall = Date.now();

      expect(result).toEqual(mockStats);

      const [startTime, endTime] = mockMessageProcessingRepository.getMessageStats.mock.calls[0];
      // startTime should be approximately 1 day ago
      const oneDayAgo = beforeCall - 86400000;
      expect(startTime).toBeGreaterThanOrEqual(oneDayAgo - 100);
      expect(startTime).toBeLessThanOrEqual(afterCall - 86400000 + 100);
      // endTime should be approximately now
      expect(endTime).toBeGreaterThanOrEqual(beforeCall);
      expect(endTime).toBeLessThanOrEqual(afterCall);
    });

    it('should pass through repository errors', async () => {
      mockMessageProcessingRepository.getMessageStats.mockRejectedValue(new Error('DB error'));

      await expect(service.getMessageStats()).rejects.toThrow('DB error');
    });
  });

  // ==================== getSlowestMessages ====================

  describe('getSlowestMessages', () => {
    it('should call repository with default limit of 10', async () => {
      const mockMessages = [{ id: '1', duration: 5000 }];
      mockMessageProcessingRepository.getSlowestMessages.mockResolvedValue(mockMessages);

      const result = await service.getSlowestMessages();

      expect(result).toEqual(mockMessages);
      const [startTime, endTime, limit] =
        mockMessageProcessingRepository.getSlowestMessages.mock.calls[0];
      expect(limit).toBe(10);
      expect(startTime).toBeUndefined();
      expect(endTime).toBeUndefined();
    });

    it('should call repository with custom limit', async () => {
      mockMessageProcessingRepository.getSlowestMessages.mockResolvedValue([]);

      await service.getSlowestMessages(undefined, undefined, 5);

      const [, , limit] = mockMessageProcessingRepository.getSlowestMessages.mock.calls[0];
      expect(limit).toBe(5);
    });

    it('should pass timestamp range when dates are provided', async () => {
      mockMessageProcessingRepository.getSlowestMessages.mockResolvedValue([]);

      await service.getSlowestMessages('2024-01-01', '2024-01-31', 20);

      const [startTime, endTime, limit] =
        mockMessageProcessingRepository.getSlowestMessages.mock.calls[0];
      expect(startTime).toBeDefined();
      expect(endTime).toBeDefined();
      expect(limit).toBe(20);
      // Start should be beginning of day
      expect(new Date(startTime).getHours()).toBe(0);
      // End should be end of day
      expect(new Date(endTime).getHours()).toBe(23);
    });

    it('should pass undefined for startTime when only endDate is provided', async () => {
      mockMessageProcessingRepository.getSlowestMessages.mockResolvedValue([]);

      await service.getSlowestMessages(undefined, '2024-01-31');

      const [startTime] = mockMessageProcessingRepository.getSlowestMessages.mock.calls[0];
      expect(startTime).toBeUndefined();
    });
  });

  // ==================== getMessageProcessingRecords ====================

  describe('getMessageProcessingRecords', () => {
    it('should call repository with parsed options', async () => {
      const mockRecords = [{ id: '1', status: 'success' }];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: mockRecords,
      });

      const result = await service.getMessageProcessingRecords({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        status: 'success',
        chatId: 'chat1',
        userName: 'Alice',
        limit: '20',
        offset: '0',
      });

      expect(result).toEqual(mockRecords);
      const [options] = mockMessageProcessingRepository.getMessageProcessingRecords.mock.calls[0];
      expect(options.status).toBe('success');
      expect(options.chatId).toBe('chat1');
      expect(options.userName).toBe('Alice');
      expect(options.limit).toBe(20);
      expect(options.offset).toBe(0);
    });

    it('should only pass provided query fields', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: [],
      });

      await service.getMessageProcessingRecords({ chatId: 'chat1' });

      const [options] = mockMessageProcessingRepository.getMessageProcessingRecords.mock.calls[0];
      expect(options.chatId).toBe('chat1');
      expect(options.status).toBeUndefined();
      expect(options.userName).toBeUndefined();
      expect(options.limit).toBeUndefined();
      expect(options.offset).toBeUndefined();
    });

    it('should set startDate to beginning of day (00:00:00)', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: [],
      });

      await service.getMessageProcessingRecords({ startDate: '2024-06-15' });

      const [options] = mockMessageProcessingRepository.getMessageProcessingRecords.mock.calls[0];
      const startDate = options.startDate as Date;
      expect(startDate.getHours()).toBe(0);
      expect(startDate.getMinutes()).toBe(0);
      expect(startDate.getSeconds()).toBe(0);
    });

    it('should set endDate to end of day (23:59:59)', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: [],
      });

      await service.getMessageProcessingRecords({ endDate: '2024-06-15' });

      const [options] = mockMessageProcessingRepository.getMessageProcessingRecords.mock.calls[0];
      const endDate = options.endDate as Date;
      expect(endDate.getHours()).toBe(23);
      expect(endDate.getMinutes()).toBe(59);
      expect(endDate.getSeconds()).toBe(59);
    });

    it('should return records array from repository result', async () => {
      const mockRecords = [{ id: '1' }, { id: '2' }];
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: mockRecords,
        total: 2,
      });

      const result = await service.getMessageProcessingRecords({});

      expect(result).toEqual(mockRecords);
    });

    it('should handle empty query', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecords.mockResolvedValue({
        records: [],
      });

      const result = await service.getMessageProcessingRecords({});

      expect(result).toEqual([]);
    });
  });

  // ==================== getMessageProcessingRecordById ====================

  describe('getMessageProcessingRecordById', () => {
    it('should call repository with message ID and return result', async () => {
      const mockRecord = { id: 'msg-123', status: 'success', duration: 1500 };
      mockMessageProcessingRepository.getMessageProcessingRecordById.mockResolvedValue(mockRecord);

      const result = await service.getMessageProcessingRecordById('msg-123');

      expect(result).toEqual(mockRecord);
      expect(mockMessageProcessingRepository.getMessageProcessingRecordById).toHaveBeenCalledWith(
        'msg-123',
      );
    });

    it('should return null when record does not exist', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecordById.mockResolvedValue(null);

      const result = await service.getMessageProcessingRecordById('nonexistent');

      expect(result).toBeNull();
    });

    it('should pass through repository errors', async () => {
      mockMessageProcessingRepository.getMessageProcessingRecordById.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(service.getMessageProcessingRecordById('msg-123')).rejects.toThrow('DB error');
    });
  });
});
