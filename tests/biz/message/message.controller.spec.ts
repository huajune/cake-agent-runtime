import { Test, TestingModule } from '@nestjs/testing';
import { MessageController } from '@biz/message/message.controller';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { AnalyticsQueryService } from '@biz/monitoring/services/dashboard/analytics-query.service';

describe('MessageController (biz/message)', () => {
  let controller: MessageController;
  let chatSessionService: ChatSessionService;
  let messageProcessingService: MessageProcessingService;
  let analyticsQueryService: AnalyticsQueryService;

  const mockChatSessionService = {
    getChatMessages: jest.fn(),
    getChatSessions: jest.fn(),
    getChatDailyStats: jest.fn(),
    getChatSummaryStats: jest.fn(),
    getChatSessionsOptimized: jest.fn(),
    getChatSessionMessages: jest.fn(),
  };

  const mockMessageProcessingService = {
    getMessageStats: jest.fn(),
    getSlowestMessages: jest.fn(),
    getMessageProcessingRecords: jest.fn(),
    getMessageProcessingRecordById: jest.fn(),
  };

  const mockAnalyticsQueryService = {
    getChatTrend: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        { provide: ChatSessionService, useValue: mockChatSessionService },
        { provide: MessageProcessingService, useValue: mockMessageProcessingService },
        { provide: AnalyticsQueryService, useValue: mockAnalyticsQueryService },
      ],
    }).compile();

    controller = module.get<MessageController>(MessageController);
    chatSessionService = module.get<ChatSessionService>(ChatSessionService);
    messageProcessingService = module.get<MessageProcessingService>(MessageProcessingService);
    analyticsQueryService = module.get<AnalyticsQueryService>(AnalyticsQueryService);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getChatMessages', () => {
    it('should call chatSessionService with default values when no query params', async () => {
      const mockResult = { data: [], total: 0 };
      mockChatSessionService.getChatMessages.mockResolvedValue(mockResult);

      const result = await controller.getChatMessages();

      expect(chatSessionService.getChatMessages).toHaveBeenCalledWith(undefined, 1, 50);
      expect(result).toEqual(mockResult);
    });

    it('should parse page and pageSize query params to integers', async () => {
      mockChatSessionService.getChatMessages.mockResolvedValue({ data: [] });

      await controller.getChatMessages('2', '20', '2024-01-15');

      expect(chatSessionService.getChatMessages).toHaveBeenCalledWith('2024-01-15', 2, 20);
    });

    it('should use default page 1 when page param is missing', async () => {
      mockChatSessionService.getChatMessages.mockResolvedValue({ data: [] });

      await controller.getChatMessages(undefined, undefined, '2024-01-15');

      expect(chatSessionService.getChatMessages).toHaveBeenCalledWith('2024-01-15', 1, 50);
    });

    it('should propagate errors from chatSessionService', async () => {
      mockChatSessionService.getChatMessages.mockRejectedValue(new Error('DB error'));

      await expect(controller.getChatMessages()).rejects.toThrow('DB error');
    });
  });

  describe('getChatSessions', () => {
    it('should call chatSessionService with all query params', async () => {
      const mockResult = { sessions: [] };
      mockChatSessionService.getChatSessions.mockResolvedValue(mockResult);

      const result = await controller.getChatSessions('7', '2024-01-01', '2024-01-07');

      expect(chatSessionService.getChatSessions).toHaveBeenCalledWith({
        days: '7',
        startDate: '2024-01-01',
        endDate: '2024-01-07',
      });
      expect(result).toEqual(mockResult);
    });

    it('should call chatSessionService with undefined params when not provided', async () => {
      mockChatSessionService.getChatSessions.mockResolvedValue({ sessions: [] });

      await controller.getChatSessions();

      expect(chatSessionService.getChatSessions).toHaveBeenCalledWith({
        days: undefined,
        startDate: undefined,
        endDate: undefined,
      });
    });

    it('should propagate errors', async () => {
      mockChatSessionService.getChatSessions.mockRejectedValue(new Error('Query failed'));

      await expect(controller.getChatSessions()).rejects.toThrow('Query failed');
    });
  });

  describe('getChatDailyStats', () => {
    it('should call chatSessionService with date range', async () => {
      const mockResult = [{ date: '2024-01-01', count: 10 }];
      mockChatSessionService.getChatDailyStats.mockResolvedValue(mockResult);

      const result = await controller.getChatDailyStats('2024-01-01', '2024-01-31');

      expect(chatSessionService.getChatDailyStats).toHaveBeenCalledWith('2024-01-01', '2024-01-31');
      expect(result).toEqual(mockResult);
    });

    it('should call without dates when not provided', async () => {
      mockChatSessionService.getChatDailyStats.mockResolvedValue([]);

      await controller.getChatDailyStats();

      expect(chatSessionService.getChatDailyStats).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('getChatSummaryStats', () => {
    it('should call chatSessionService with date range', async () => {
      const mockResult = { totalSessions: 100, uniqueUsers: 50 };
      mockChatSessionService.getChatSummaryStats.mockResolvedValue(mockResult);

      const result = await controller.getChatSummaryStats('2024-01-01', '2024-01-31');

      expect(chatSessionService.getChatSummaryStats).toHaveBeenCalledWith(
        '2024-01-01',
        '2024-01-31',
      );
      expect(result).toEqual(mockResult);
    });

    it('should call without dates when not provided', async () => {
      mockChatSessionService.getChatSummaryStats.mockResolvedValue({});

      await controller.getChatSummaryStats();

      expect(chatSessionService.getChatSummaryStats).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('getChatSessionsOptimized', () => {
    it('should call chatSessionService with date range', async () => {
      const mockResult = { data: [] };
      mockChatSessionService.getChatSessionsOptimized.mockResolvedValue(mockResult);

      const result = await controller.getChatSessionsOptimized('2024-01-01', '2024-01-31');

      expect(chatSessionService.getChatSessionsOptimized).toHaveBeenCalledWith(
        '2024-01-01',
        '2024-01-31',
      );
      expect(result).toEqual(mockResult);
    });
  });

  describe('getChatTrend', () => {
    it('should call chatSessionService with parsed days', async () => {
      const mockResult = [{ date: '2024-01-01', value: 5 }];
      mockAnalyticsQueryService.getChatTrend.mockResolvedValue(mockResult);

      const result = await controller.getChatTrend('7');

      expect(analyticsQueryService.getChatTrend).toHaveBeenCalledWith(7);
      expect(result).toEqual(mockResult);
    });

    it('should call with undefined when days not provided', async () => {
      mockAnalyticsQueryService.getChatTrend.mockResolvedValue([]);

      await controller.getChatTrend();

      expect(analyticsQueryService.getChatTrend).toHaveBeenCalledWith(undefined);
    });
  });

  describe('getChatSessionMessages', () => {
    it('should call chatSessionService with chatId param', async () => {
      const chatId = 'chat-abc-123';
      const mockResult = { messages: [{ content: 'Hello' }] };
      mockChatSessionService.getChatSessionMessages.mockResolvedValue(mockResult);

      const result = await controller.getChatSessionMessages(chatId);

      expect(chatSessionService.getChatSessionMessages).toHaveBeenCalledWith(chatId);
      expect(result).toEqual(mockResult);
    });

    it('should propagate errors from chatSessionService', async () => {
      mockChatSessionService.getChatSessionMessages.mockRejectedValue(
        new Error('Session not found'),
      );

      await expect(controller.getChatSessionMessages('nonexistent')).rejects.toThrow(
        'Session not found',
      );
    });
  });

  describe('getMessageStats', () => {
    it('should call messageProcessingService with date range', async () => {
      const mockResult = { totalMessages: 500, successRate: 0.98 };
      mockMessageProcessingService.getMessageStats.mockResolvedValue(mockResult);

      const result = await controller.getMessageStats('2024-01-01', '2024-01-31');

      expect(messageProcessingService.getMessageStats).toHaveBeenCalledWith(
        '2024-01-01',
        '2024-01-31',
      );
      expect(result).toEqual(mockResult);
    });

    it('should call without dates when not provided', async () => {
      mockMessageProcessingService.getMessageStats.mockResolvedValue({});

      await controller.getMessageStats();

      expect(messageProcessingService.getMessageStats).toHaveBeenCalledWith(undefined, undefined);
    });
  });

  describe('getSlowestMessages', () => {
    it('should call messageProcessingService with all params', async () => {
      const mockResult = [{ messageId: 'msg-1', duration: 5000 }];
      mockMessageProcessingService.getSlowestMessages.mockResolvedValue(mockResult);

      const result = await controller.getSlowestMessages('2024-01-01', '2024-01-31', '10');

      expect(messageProcessingService.getSlowestMessages).toHaveBeenCalledWith(
        '2024-01-01',
        '2024-01-31',
        10,
      );
      expect(result).toEqual(mockResult);
    });

    it('should call with undefined limit when not provided', async () => {
      mockMessageProcessingService.getSlowestMessages.mockResolvedValue([]);

      await controller.getSlowestMessages();

      expect(messageProcessingService.getSlowestMessages).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
      );
    });
  });

  describe('getMessageProcessingRecords', () => {
    it('should call messageProcessingService with all filter params', async () => {
      const mockResult = { data: [], total: 0 };
      mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue(mockResult);

      const result = await controller.getMessageProcessingRecords(
        '2024-01-01',
        '2024-01-31',
        'success',
        'chat-1',
        'User1',
        '50',
        '0',
      );

      expect(messageProcessingService.getMessageProcessingRecords).toHaveBeenCalledWith({
        startDate: '2024-01-01',
        endDate: '2024-01-31',
        status: 'success',
        chatId: 'chat-1',
        userName: 'User1',
        limit: '50',
        offset: '0',
      });
      expect(result).toEqual(mockResult);
    });

    it('should call with undefined values when params not provided', async () => {
      mockMessageProcessingService.getMessageProcessingRecords.mockResolvedValue({ data: [] });

      await controller.getMessageProcessingRecords();

      expect(messageProcessingService.getMessageProcessingRecords).toHaveBeenCalledWith({
        startDate: undefined,
        endDate: undefined,
        status: undefined,
        chatId: undefined,
        userName: undefined,
        limit: undefined,
        offset: undefined,
      });
    });
  });

  describe('getMessageProcessingRecordDetail', () => {
    it('should call messageProcessingService with messageId', async () => {
      const messageId = 'msg-uuid-001';
      const mockResult = { id: messageId, status: 'success', duration: 1200 };
      mockMessageProcessingService.getMessageProcessingRecordById.mockResolvedValue(mockResult);

      const result = await controller.getMessageProcessingRecordDetail(messageId);

      expect(messageProcessingService.getMessageProcessingRecordById).toHaveBeenCalledWith(
        messageId,
      );
      expect(result).toEqual(mockResult);
    });

    it('should propagate errors when record not found', async () => {
      mockMessageProcessingService.getMessageProcessingRecordById.mockRejectedValue(
        new Error('Record not found'),
      );

      await expect(controller.getMessageProcessingRecordDetail('nonexistent')).rejects.toThrow(
        'Record not found',
      );
    });
  });
});
