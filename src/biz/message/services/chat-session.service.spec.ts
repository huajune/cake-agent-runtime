import { Test, TestingModule } from '@nestjs/testing';
import { ChatSessionService } from './chat-session.service';
import { ChatMessageRepository } from '../repositories/chat-message.repository';
import { MonitoringRepository } from '@biz/monitoring/repositories/monitoring.repository';

describe('ChatSessionService', () => {
  let service: ChatSessionService;

  const mockChatMessageRepository = {
    getTodayChatMessages: jest.fn(),
    getChatSessionListByDateRange: jest.fn(),
    getChatSessionList: jest.fn(),
    getChatDailyStats: jest.fn(),
    getChatSummaryStats: jest.fn(),
    getChatSessionListOptimized: jest.fn(),
    getChatHistoryDetail: jest.fn(),
  };

  const mockMonitoringRepository = {
    getDashboardHourlyTrend: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ChatSessionService,
        { provide: ChatMessageRepository, useValue: mockChatMessageRepository },
        { provide: MonitoringRepository, useValue: mockMonitoringRepository },
      ],
    }).compile();

    service = module.get<ChatSessionService>(ChatSessionService);

    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ==================== getChatMessages ====================

  describe('getChatMessages', () => {
    it('should call repository with today when no date provided', async () => {
      const mockMessages = [{ id: '1', content: 'hello' }];
      mockChatMessageRepository.getTodayChatMessages.mockResolvedValue(mockMessages);

      const result = await service.getChatMessages();

      expect(result).toEqual(mockMessages);
      const [date, page, pageSize] = mockChatMessageRepository.getTodayChatMessages.mock.calls[0];
      expect(date).toBeInstanceOf(Date);
      expect(page).toBe(1);
      expect(pageSize).toBe(50);
    });

    it('should use provided date, page, and pageSize', async () => {
      mockChatMessageRepository.getTodayChatMessages.mockResolvedValue([]);

      await service.getChatMessages('2024-06-15', 2, 100);

      const [date, page, pageSize] = mockChatMessageRepository.getTodayChatMessages.mock.calls[0];
      expect(date.toISOString().startsWith('2024-06-15')).toBe(true);
      expect(page).toBe(2);
      expect(pageSize).toBe(100);
    });
  });

  // ==================== getChatSessions ====================

  describe('getChatSessions', () => {
    it('should use date range when startDate is provided', async () => {
      const mockSessions = [{ chatId: 'chat1' }];
      mockChatMessageRepository.getChatSessionListByDateRange.mockResolvedValue(mockSessions);

      const result = await service.getChatSessions({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
      });

      expect(result).toEqual({ sessions: mockSessions });
      expect(mockChatMessageRepository.getChatSessionListByDateRange).toHaveBeenCalledTimes(1);
      expect(mockChatMessageRepository.getChatSessionList).not.toHaveBeenCalled();

      const [start, end] = mockChatMessageRepository.getChatSessionListByDateRange.mock.calls[0];
      expect(start.getHours()).toBe(0); // start of day
      expect(end.getHours()).toBe(23); // end of day
    });

    it('should use days-based query when no startDate provided', async () => {
      const mockSessions = [{ chatId: 'chat1' }];
      mockChatMessageRepository.getChatSessionList.mockResolvedValue(mockSessions);

      const result = await service.getChatSessions({ days: '7' });

      expect(result).toEqual({ sessions: mockSessions });
      expect(mockChatMessageRepository.getChatSessionList).toHaveBeenCalledWith(7);
      expect(mockChatMessageRepository.getChatSessionListByDateRange).not.toHaveBeenCalled();
    });

    it('should default to 1 day when no days option provided', async () => {
      mockChatMessageRepository.getChatSessionList.mockResolvedValue([]);

      await service.getChatSessions({});

      expect(mockChatMessageRepository.getChatSessionList).toHaveBeenCalledWith(1);
    });

    it('should use end of today when no endDate provided for date range', async () => {
      mockChatMessageRepository.getChatSessionListByDateRange.mockResolvedValue([]);

      await service.getChatSessions({ startDate: '2024-01-01' });

      const [, end] = mockChatMessageRepository.getChatSessionListByDateRange.mock.calls[0];
      expect(end.getHours()).toBe(23);
      expect(end.getMinutes()).toBe(59);
    });
  });

  // ==================== getChatDailyStats ====================

  describe('getChatDailyStats', () => {
    it('should call repository with 30-day default range', async () => {
      const mockStats = [{ date: '2024-01-01', count: 10 }];
      mockChatMessageRepository.getChatDailyStats.mockResolvedValue(mockStats);

      const result = await service.getChatDailyStats();

      expect(result).toEqual(mockStats);
      const [start, end] = mockChatMessageRepository.getChatDailyStats.mock.calls[0];
      expect(start).toBeInstanceOf(Date);
      expect(end).toBeInstanceOf(Date);
      expect(start.getHours()).toBe(0);
      expect(end.getHours()).toBe(23);
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatDailyStats.mockResolvedValue([]);

      await service.getChatDailyStats('2024-01-01', '2024-01-31');

      const [start, end] = mockChatMessageRepository.getChatDailyStats.mock.calls[0];
      // Check full year/month match (local time)
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(0); // January = 0
      expect(start.getDate()).toBe(1);
      expect(start.getHours()).toBe(0);
      expect(end.getHours()).toBe(23);
    });
  });

  // ==================== getChatSummaryStats ====================

  describe('getChatSummaryStats', () => {
    it('should call repository with 30-day default range', async () => {
      const mockStats = { total: 100, active: 50 };
      mockChatMessageRepository.getChatSummaryStats.mockResolvedValue(mockStats);

      const result = await service.getChatSummaryStats();

      expect(result).toEqual(mockStats);
      expect(mockChatMessageRepository.getChatSummaryStats).toHaveBeenCalledTimes(1);
      const [start] = mockChatMessageRepository.getChatSummaryStats.mock.calls[0];
      expect(start.getHours()).toBe(0); // start of day
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatSummaryStats.mockResolvedValue(null);

      await service.getChatSummaryStats('2024-06-01', '2024-06-30');

      const [start, end] = mockChatMessageRepository.getChatSummaryStats.mock.calls[0];
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(5); // June = 5
      expect(start.getDate()).toBe(1);
      expect(end.getHours()).toBe(23);
    });
  });

  // ==================== getChatSessionsOptimized ====================

  describe('getChatSessionsOptimized', () => {
    it('should call optimized repository method with 30-day range', async () => {
      const mockSessions = [{ chatId: 'chat1', messages: 10 }];
      mockChatMessageRepository.getChatSessionListOptimized.mockResolvedValue(mockSessions);

      const result = await service.getChatSessionsOptimized();

      expect(result).toEqual(mockSessions);
      expect(mockChatMessageRepository.getChatSessionListOptimized).toHaveBeenCalledTimes(1);
    });

    it('should use provided date range', async () => {
      mockChatMessageRepository.getChatSessionListOptimized.mockResolvedValue([]);

      await service.getChatSessionsOptimized('2024-01-01', '2024-01-31');

      const [start, end] = mockChatMessageRepository.getChatSessionListOptimized.mock.calls[0];
      expect(start.getFullYear()).toBe(2024);
      expect(start.getMonth()).toBe(0); // January = 0
      expect(start.getDate()).toBe(1);
      expect(end.getHours()).toBe(23);
    });
  });

  // ==================== getChatTrend ====================

  describe('getChatTrend', () => {
    it('should call monitoring repository and transform response', async () => {
      const mockHourlyData = [
        { hour: '2024-01-01T10:00:00Z', messageCount: 5, uniqueUsers: 3 },
        { hour: '2024-01-01T11:00:00Z', messageCount: 8, uniqueUsers: 4 },
      ];
      mockMonitoringRepository.getDashboardHourlyTrend.mockResolvedValue(mockHourlyData);

      const result = await service.getChatTrend(7);

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        hour: '2024-01-01T10:00:00Z',
        message_count: 5,
        active_users: 3,
        active_chats: 0,
      });
      expect(result[1]).toMatchObject({
        hour: '2024-01-01T11:00:00Z',
        message_count: 8,
        active_users: 4,
        active_chats: 0,
      });
    });

    it('should use default 7 days when no parameter provided', async () => {
      mockMonitoringRepository.getDashboardHourlyTrend.mockResolvedValue([]);

      await service.getChatTrend();

      const [startDate, endDate] = mockMonitoringRepository.getDashboardHourlyTrend.mock.calls[0];
      const daysDiff = Math.round(
        (endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24),
      );
      expect(daysDiff).toBe(7);
    });

    it('should return empty array when no trend data', async () => {
      mockMonitoringRepository.getDashboardHourlyTrend.mockResolvedValue([]);

      const result = await service.getChatTrend(3);

      expect(result).toEqual([]);
    });
  });

  // ==================== getChatSessionMessages ====================

  describe('getChatSessionMessages', () => {
    it('should return session messages with chatId', async () => {
      const mockMessages = [
        { id: '1', content: 'hello' },
        { id: '2', content: 'world' },
      ];
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue(mockMessages);

      const result = await service.getChatSessionMessages('chat-123');

      expect(result).toEqual({ chatId: 'chat-123', messages: mockMessages });
      expect(mockChatMessageRepository.getChatHistoryDetail).toHaveBeenCalledWith('chat-123');
    });

    it('should return empty messages array when no messages found', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockResolvedValue([]);

      const result = await service.getChatSessionMessages('chat-empty');

      expect(result).toEqual({ chatId: 'chat-empty', messages: [] });
    });

    it('should pass through repository errors', async () => {
      mockChatMessageRepository.getChatHistoryDetail.mockRejectedValue(new Error('DB error'));

      await expect(service.getChatSessionMessages('chat-123')).rejects.toThrow('DB error');
    });
  });
});
