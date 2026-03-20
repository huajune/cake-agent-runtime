import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { MessageService } from '@wecom/message/message.service';
import { MessageHistoryService } from '@wecom/message/services/history.service';
import { SimpleMergeService } from '@wecom/message/services/simple-merge.service';
import { MessageStatisticsService } from '@wecom/message/services/statistics.service';
import { MessagePipelineService } from '@wecom/message/services/pipeline.service';
import { MessageTrackingService } from '@biz/monitoring/services/tracking/message-tracking.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/dto/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';

describe('MessageService', () => {
  let service: MessageService;

  const mockHistoryService = {
    getHistoryDetail: jest.fn(),
    getStats: jest.fn(),
  };

  const mockSimpleMergeService = {
    addMessage: jest.fn(),
    getStats: jest.fn(),
  };

  const mockStatisticsService = {
    getServiceStatus: jest.fn(),
    getCacheStats: jest.fn(),
    clearCache: jest.fn(),
  };

  const mockPipelineService = {
    handleSelfMessage: jest.fn(),
    filterMessage: jest.fn(),
    checkDuplicationAsync: jest.fn(),
    recordUserMessageToHistory: jest.fn(),
    recordMessageReceived: jest.fn(),
    processSingleMessage: jest.fn(),
    processMergedMessages: jest.fn(),
  };

  const mockMonitoringService = {
    recordSuccess: jest.fn(),
    recordFailure: jest.fn(),
  };

  const mockSystemConfigService = {
    getAiReplyEnabled: jest.fn(),
    getMessageMergeEnabled: jest.fn(),
    setAiReplyEnabled: jest.fn(),
    setMessageMergeEnabled: jest.fn(),
  };

  const mockConfigService = {
    get: jest.fn().mockImplementation((key: string, defaultValue?: string) => {
      if (key === 'ENABLE_AI_REPLY') return 'true';
      if (key === 'ENABLE_MESSAGE_MERGE') return 'true';
      return defaultValue;
    }),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1700000000000',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    imContactId: 'contact-123',
    contactName: 'Alice',
    payload: { text: 'Hello!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageService,
        { provide: ConfigService, useValue: mockConfigService },
        { provide: MessageHistoryService, useValue: mockHistoryService },
        { provide: SimpleMergeService, useValue: mockSimpleMergeService },
        { provide: MessageStatisticsService, useValue: mockStatisticsService },
        { provide: MessagePipelineService, useValue: mockPipelineService },
        { provide: MessageTrackingService, useValue: mockMonitoringService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
      ],
    }).compile();

    service = module.get<MessageService>(MessageService);
    jest.clearAllMocks();

    // Default: AI reply enabled, message merge enabled
    mockSystemConfigService.getAiReplyEnabled.mockResolvedValue(true);
    mockSystemConfigService.getMessageMergeEnabled.mockResolvedValue(true);
    mockSystemConfigService.setAiReplyEnabled.mockResolvedValue(undefined);
    mockSystemConfigService.setMessageMergeEnabled.mockResolvedValue(undefined);
    mockPipelineService.handleSelfMessage.mockResolvedValue(undefined);
    mockPipelineService.filterMessage.mockResolvedValue({
      continue: true,
      data: { content: 'Hello!' },
    });
    mockPipelineService.checkDuplicationAsync.mockResolvedValue({ continue: true });
    mockPipelineService.recordUserMessageToHistory.mockResolvedValue(undefined);
    mockPipelineService.recordMessageReceived.mockReturnValue(undefined);
    mockPipelineService.processSingleMessage.mockResolvedValue(undefined);
    mockPipelineService.processMergedMessages.mockResolvedValue(undefined);
    mockSimpleMergeService.addMessage.mockResolvedValue(undefined);
    mockMonitoringService.recordSuccess.mockReturnValue(undefined);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should load AI reply and message merge status from Supabase', async () => {
      await service.onModuleInit();

      expect(mockSystemConfigService.getAiReplyEnabled).toHaveBeenCalled();
      expect(mockSystemConfigService.getMessageMergeEnabled).toHaveBeenCalled();
    });

    it('should apply Supabase config to override env variable defaults', async () => {
      mockSystemConfigService.getAiReplyEnabled.mockResolvedValue(false);
      mockSystemConfigService.getMessageMergeEnabled.mockResolvedValue(false);

      await service.onModuleInit();

      expect(service.getAiReplyStatus()).toBe(false);
      expect(service.getMessageMergeStatus()).toBe(false);
    });
  });

  describe('handleMessage', () => {
    beforeEach(async () => {
      await service.onModuleInit();
    });

    it('should handle self message and return early', async () => {
      const selfMessage = { ...validMessageData, isSelf: true };

      const result = await service.handleMessage(selfMessage);

      expect(mockPipelineService.handleSelfMessage).toHaveBeenCalledWith(selfMessage);
      expect(result).toMatchObject({ success: true, message: 'Self message stored' });
      expect(mockPipelineService.filterMessage).not.toHaveBeenCalled();
    });

    it('should return early when message is filtered out', async () => {
      mockPipelineService.filterMessage.mockResolvedValue({
        continue: false,
        response: { success: true, message: 'Filtered' },
      });

      const result = await service.handleMessage(validMessageData);

      expect(result).toMatchObject({ success: true, message: 'Filtered' });
      expect(mockPipelineService.checkDuplicationAsync).not.toHaveBeenCalled();
    });

    it('should return early when message is a duplicate', async () => {
      mockPipelineService.checkDuplicationAsync.mockResolvedValue({
        continue: false,
        response: { success: true, message: 'Duplicate message ignored' },
      });

      const result = await service.handleMessage(validMessageData);

      expect(result).toMatchObject({ success: true, message: 'Duplicate message ignored' });
    });

    it('should record history and return success when AI reply is disabled', async () => {
      mockSystemConfigService.getAiReplyEnabled.mockResolvedValue(false);
      await service.onModuleInit();

      const result = await service.handleMessage(validMessageData);

      expect(mockPipelineService.recordUserMessageToHistory).toHaveBeenCalled();
      expect(mockMonitoringService.recordSuccess).toHaveBeenCalled();
      expect(result).toMatchObject({
        success: true,
        message: 'AI reply disabled, message recorded to history',
      });
    });

    it('should dispatch to merge queue when message merge is enabled', async () => {
      const result = await service.handleMessage(validMessageData);

      expect(result).toMatchObject({ success: true, message: 'Message received' });
      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockSimpleMergeService.addMessage).toHaveBeenCalledWith(validMessageData);
    });

    it('should process message directly when message merge is disabled', async () => {
      mockSystemConfigService.getMessageMergeEnabled.mockResolvedValue(false);
      await service.onModuleInit();

      const result = await service.handleMessage(validMessageData);

      expect(result).toMatchObject({ success: true, message: 'Message received' });
      // Wait for async dispatch
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(mockPipelineService.processSingleMessage).toHaveBeenCalledWith(validMessageData);
    });

    it('should execute all pipeline steps in correct order', async () => {
      const callOrder: string[] = [];
      mockPipelineService.filterMessage.mockImplementation(async () => {
        callOrder.push('filter');
        return { continue: true, data: { content: 'Hello!' } };
      });
      mockPipelineService.checkDuplicationAsync.mockImplementation(async () => {
        callOrder.push('dedup');
        return { continue: true };
      });
      mockPipelineService.recordUserMessageToHistory.mockImplementation(async () => {
        callOrder.push('history');
      });
      mockPipelineService.recordMessageReceived.mockImplementation(() => {
        callOrder.push('monitoring');
      });

      await service.handleMessage(validMessageData);

      expect(callOrder).toEqual(['filter', 'dedup', 'history', 'monitoring']);
    });
  });

  describe('processMergedMessages', () => {
    it('should delegate to pipeline service and track processing count', async () => {
      await service.processMergedMessages([validMessageData], 'batch-001');

      expect(mockPipelineService.processMergedMessages).toHaveBeenCalledWith(
        [validMessageData],
        'batch-001',
      );
    });

    it('should decrement processing count even when pipeline throws', async () => {
      mockPipelineService.processMergedMessages.mockRejectedValue(new Error('Pipeline error'));

      await expect(service.processMergedMessages([validMessageData], 'batch-err')).rejects.toThrow(
        'Pipeline error',
      );
    });
  });

  describe('handleSentResult', () => {
    it('should return success for any result data', async () => {
      const result = await service.handleSentResult({ requestId: 'req-123', status: 'success' });

      expect(result).toEqual({ success: true });
    });

    it('should handle undefined resultData', async () => {
      const result = await service.handleSentResult(undefined);

      expect(result).toEqual({ success: true });
    });
  });

  describe('getAiReplyStatus', () => {
    it('should return current AI reply status', async () => {
      await service.onModuleInit();
      expect(service.getAiReplyStatus()).toBe(true);
    });
  });

  describe('toggleAiReply', () => {
    it('should enable AI reply and persist to Supabase', async () => {
      const result = await service.toggleAiReply(true);

      expect(result).toBe(true);
      expect(mockSystemConfigService.setAiReplyEnabled).toHaveBeenCalledWith(true);
      expect(service.getAiReplyStatus()).toBe(true);
    });

    it('should disable AI reply and persist to Supabase', async () => {
      const result = await service.toggleAiReply(false);

      expect(result).toBe(false);
      expect(mockSystemConfigService.setAiReplyEnabled).toHaveBeenCalledWith(false);
      expect(service.getAiReplyStatus()).toBe(false);
    });
  });

  describe('getMessageMergeStatus', () => {
    it('should return current message merge status', async () => {
      await service.onModuleInit();
      expect(service.getMessageMergeStatus()).toBe(true);
    });
  });

  describe('toggleMessageMerge', () => {
    it('should enable message merge and persist to Supabase', async () => {
      const result = await service.toggleMessageMerge(true);

      expect(result).toBe(true);
      expect(mockSystemConfigService.setMessageMergeEnabled).toHaveBeenCalledWith(true);
    });

    it('should disable message merge and persist to Supabase', async () => {
      const result = await service.toggleMessageMerge(false);

      expect(result).toBe(false);
      expect(mockSystemConfigService.setMessageMergeEnabled).toHaveBeenCalledWith(false);
    });
  });

  describe('getServiceStatus', () => {
    it('should delegate to statistics service', () => {
      const mockStatus = { processingCount: 0, aiReplyEnabled: true };
      mockStatisticsService.getServiceStatus.mockReturnValue(mockStatus);

      const result = service.getServiceStatus();

      expect(result).toEqual(mockStatus);
      expect(mockStatisticsService.getServiceStatus).toHaveBeenCalled();
    });
  });

  describe('getCacheStats', () => {
    it('should delegate to statistics service', () => {
      const mockStats = { processing: { currentCount: 0 } };
      mockStatisticsService.getCacheStats.mockReturnValue(mockStats);

      const result = service.getCacheStats();

      expect(result).toEqual(mockStats);
      expect(mockStatisticsService.getCacheStats).toHaveBeenCalled();
    });
  });

  describe('getAllHistory', () => {
    it('should return stats when no chatId provided', async () => {
      const mockStats = { storageType: 'supabase' };
      mockHistoryService.getStats.mockReturnValue(mockStats);

      const result = await service.getAllHistory();

      expect(result).toEqual(mockStats);
      expect(mockHistoryService.getStats).toHaveBeenCalled();
    });

    it('should return chat history detail when chatId provided', async () => {
      const mockDetail = {
        chatId: 'chat-123',
        messages: [{ role: 'user', content: 'Hello', timestamp: 1000 }],
        messageCount: 1,
      };
      mockHistoryService.getHistoryDetail.mockResolvedValue(mockDetail);

      const result = await service.getAllHistory('chat-123');

      expect(result).toMatchObject({
        chatId: 'chat-123',
        count: 1,
      });
    });

    it('should return empty messages when chatId history not found', async () => {
      mockHistoryService.getHistoryDetail.mockResolvedValue(null);

      const result = await service.getAllHistory('nonexistent-chat');

      expect(result).toMatchObject({
        chatId: 'nonexistent-chat',
        messages: [],
        count: 0,
      });
    });
  });

  describe('clearCache', () => {
    it('should delegate to statistics service', async () => {
      const mockResult = { timestamp: '2024-01-01', cleared: { deduplication: true } };
      mockStatisticsService.clearCache.mockResolvedValue(mockResult);

      const result = await service.clearCache({ deduplication: true });

      expect(result).toEqual(mockResult);
      expect(mockStatisticsService.clearCache).toHaveBeenCalledWith({ deduplication: true });
    });

    it('should clear all when no options provided', async () => {
      const mockResult = {
        timestamp: '2024-01-01',
        cleared: { deduplication: true, history: true },
      };
      mockStatisticsService.clearCache.mockResolvedValue(mockResult);

      await service.clearCache();

      expect(mockStatisticsService.clearCache).toHaveBeenCalledWith(undefined);
    });
  });
});
