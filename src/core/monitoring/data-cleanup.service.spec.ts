import { Test, TestingModule } from '@nestjs/testing';
import { DataCleanupService } from './data-cleanup.service';
import { SupabaseService } from '@core/supabase';
import { ChatMessageRepository, MessageProcessingRepository } from '@biz/message/repositories';
import { MonitoringErrorLogRepository } from '@biz/analytics/repositories';
import { UserHostingRepository } from '@biz/user/repositories';

describe('DataCleanupService', () => {
  let service: DataCleanupService;
  let supabaseService: jest.Mocked<SupabaseService>;
  let chatMessageRepository: jest.Mocked<ChatMessageRepository>;
  let messageProcessingRepository: jest.Mocked<MessageProcessingRepository>;
  let _userHostingRepository: jest.Mocked<UserHostingRepository>;

  const mockSupabaseService = {
    isAvailable: jest.fn(),
  };

  const mockChatMessageRepository = {
    cleanupChatMessages: jest.fn(),
  };

  const mockMessageProcessingRepository = {
    nullAgentInvocations: jest.fn(),
    cleanupMessageProcessingRecords: jest.fn(),
  };

  const mockUserHostingRepository = {
    cleanupUserActivity: jest.fn(),
  };

  const mockErrorLogRepository = {
    cleanupErrorLogs: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataCleanupService,
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
        {
          provide: ChatMessageRepository,
          useValue: mockChatMessageRepository,
        },
        {
          provide: MessageProcessingRepository,
          useValue: mockMessageProcessingRepository,
        },
        {
          provide: UserHostingRepository,
          useValue: mockUserHostingRepository,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
      ],
    }).compile();

    service = module.get<DataCleanupService>(DataCleanupService);
    supabaseService = module.get(SupabaseService);
    chatMessageRepository = module.get(ChatMessageRepository);
    messageProcessingRepository = module.get(MessageProcessingRepository);
    _userHostingRepository = module.get(UserHostingRepository);

    // Reset mocks
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should log enabled when Supabase is available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      await service.onModuleInit();
      expect(supabaseService.isAvailable).toHaveBeenCalled();
    });

    it('should log disabled when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);
      await service.onModuleInit();
      expect(supabaseService.isAvailable).toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredData', () => {
    it('should run tiered cleanup when Supabase is available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingRepository.nullAgentInvocations.mockResolvedValue(20);
      mockChatMessageRepository.cleanupChatMessages.mockResolvedValue(10);
      mockMessageProcessingRepository.cleanupMessageProcessingRecords.mockResolvedValue(5);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(3);
      mockUserHostingRepository.cleanupUserActivity.mockResolvedValue(2);

      await service.cleanupExpiredData();

      // 1. NULL agent_invocation (>7 天)
      expect(messageProcessingRepository.nullAgentInvocations).toHaveBeenCalledWith(7);
      // 2. DELETE chat_messages (>60 天)
      expect(chatMessageRepository.cleanupChatMessages).toHaveBeenCalledWith(60);
      // 3. DELETE message_processing_records (>14 天)
      expect(messageProcessingRepository.cleanupMessageProcessingRecords).toHaveBeenCalledWith(14);
      // 4. DELETE monitoring_error_logs (>30 天)
      expect(mockErrorLogRepository.cleanupErrorLogs).toHaveBeenCalledWith(30);
      // 5. DELETE user_activity (>35 天)
      expect(mockUserHostingRepository.cleanupUserActivity).toHaveBeenCalledWith(35);
    });

    it('should skip cleanup when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      await service.cleanupExpiredData();

      expect(messageProcessingRepository.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatMessageRepository.cleanupChatMessages).not.toHaveBeenCalled();
      expect(messageProcessingRepository.cleanupMessageProcessingRecords).not.toHaveBeenCalled();
      expect(mockErrorLogRepository.cleanupErrorLogs).not.toHaveBeenCalled();
      expect(mockUserHostingRepository.cleanupUserActivity).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully during agent_invocation cleanup', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingRepository.nullAgentInvocations.mockRejectedValue(
        new Error('Database error'),
      );
      mockChatMessageRepository.cleanupChatMessages.mockResolvedValue(0);
      mockMessageProcessingRepository.cleanupMessageProcessingRecords.mockResolvedValue(0);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(0);

      // Should not throw
      await expect(service.cleanupExpiredData()).resolves.not.toThrow();
      // Should continue to next steps even after error
      expect(chatMessageRepository.cleanupChatMessages).toHaveBeenCalled();
    });
  });

  describe('triggerCleanup', () => {
    it('should return cleanup counts when Supabase is available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingRepository.nullAgentInvocations.mockResolvedValue(20);
      mockChatMessageRepository.cleanupChatMessages.mockResolvedValue(15);
      mockMessageProcessingRepository.cleanupMessageProcessingRecords.mockResolvedValue(8);
      mockUserHostingRepository.cleanupUserActivity.mockResolvedValue(3);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(5);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 20,
        chatMessages: 15,
        processingRecords: 8,
        userActivity: 3,
        errorLogs: 5,
      });
    });

    it('should return zeros when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 0,
        chatMessages: 0,
        processingRecords: 0,
        userActivity: 0,
        errorLogs: 0,
      });
      expect(messageProcessingRepository.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatMessageRepository.cleanupChatMessages).not.toHaveBeenCalled();
    });

    it('should handle partial failures gracefully', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingRepository.nullAgentInvocations.mockResolvedValue(10);
      mockChatMessageRepository.cleanupChatMessages.mockRejectedValue(new Error('Error'));
      mockMessageProcessingRepository.cleanupMessageProcessingRecords.mockResolvedValue(4);
      mockUserHostingRepository.cleanupUserActivity.mockResolvedValue(2);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(1);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 10,
        chatMessages: 0,
        processingRecords: 4,
        userActivity: 2,
        errorLogs: 1,
      });
    });
  });
});
