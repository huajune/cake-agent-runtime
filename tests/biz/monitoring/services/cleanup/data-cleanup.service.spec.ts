import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataCleanupService } from '@biz/monitoring/services/cleanup/data-cleanup.service';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { UserHostingService } from '@biz/user/services/user-hosting.service';

describe('DataCleanupService', () => {
  let service: DataCleanupService;
  let supabaseService: jest.Mocked<SupabaseService>;
  let chatSessionService: jest.Mocked<ChatSessionService>;
  let messageProcessingService: jest.Mocked<MessageProcessingService>;
  let _userHostingService: jest.Mocked<UserHostingService>;

  const mockSupabaseService = {
    isAvailable: jest.fn(),
  };

  const cleanupRecordsMock = jest.fn();
  const cleanupActivityMock = jest.fn();

  const mockChatSessionService = {
    cleanupChatMessages: jest.fn(),
  };

  const mockMessageProcessingService = {
    nullAgentInvocations: jest.fn(),
    cleanupRecords: cleanupRecordsMock,
    cleanupMessageProcessingRecords: cleanupRecordsMock,
  };

  const mockUserHostingService = {
    cleanupActivity: cleanupActivityMock,
    cleanupUserActivity: cleanupActivityMock,
  };

  const mockErrorLogRepository = {
    cleanupErrorLogs: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        DataCleanupService,
        {
          provide: ConfigService,
          useValue: {
            get: jest
              .fn()
              .mockImplementation((_key: string, defaultValue?: string) => defaultValue),
          },
        },
        {
          provide: SupabaseService,
          useValue: mockSupabaseService,
        },
        {
          provide: ChatSessionService,
          useValue: mockChatSessionService,
        },
        {
          provide: MessageProcessingService,
          useValue: mockMessageProcessingService,
        },
        {
          provide: UserHostingService,
          useValue: mockUserHostingService,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
      ],
    }).compile();

    service = module.get<DataCleanupService>(DataCleanupService);
    supabaseService = module.get(SupabaseService);
    chatSessionService = module.get(ChatSessionService);
    messageProcessingService = module.get(MessageProcessingService);
    _userHostingService = module.get(UserHostingService);

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
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(20);
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(10);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(5);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(3);
      mockUserHostingService.cleanupActivity.mockResolvedValue(2);

      await service.cleanupExpiredData();

      // 1. NULL agent_invocation (>7 天)
      expect(messageProcessingService.nullAgentInvocations).toHaveBeenCalledWith(7);
      // 2. DELETE chat_messages (>60 天)
      expect(chatSessionService.cleanupChatMessages).toHaveBeenCalledWith(60);
      // 3. DELETE message_processing_records (>14 天)
      expect(messageProcessingService.cleanupRecords).toHaveBeenCalledWith(14);
      // 4. DELETE monitoring_error_logs (>30 天)
      expect(mockErrorLogRepository.cleanupErrorLogs).toHaveBeenCalledWith(30);
      // 5. DELETE user_activity (>35 天)
      expect(mockUserHostingService.cleanupActivity).toHaveBeenCalledWith(35);
    });

    it('should skip cleanup when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      await service.cleanupExpiredData();

      expect(messageProcessingService.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatSessionService.cleanupChatMessages).not.toHaveBeenCalled();
      expect(messageProcessingService.cleanupRecords).not.toHaveBeenCalled();
      expect(mockErrorLogRepository.cleanupErrorLogs).not.toHaveBeenCalled();
      expect(mockUserHostingService.cleanupActivity).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully during agent_invocation cleanup', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockRejectedValue(
        new Error('Database error'),
      );
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(0);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(0);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(0);

      // Should not throw
      await expect(service.cleanupExpiredData()).resolves.not.toThrow();
      // Should continue to next steps even after error
      expect(chatSessionService.cleanupChatMessages).toHaveBeenCalled();
    });
  });

  describe('triggerCleanup', () => {
    it('should return cleanup counts when Supabase is available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(20);
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(15);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(8);
      mockUserHostingService.cleanupActivity.mockResolvedValue(3);
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
      expect(messageProcessingService.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatSessionService.cleanupChatMessages).not.toHaveBeenCalled();
    });

    it('should handle partial failures gracefully', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(10);
      mockChatSessionService.cleanupChatMessages.mockRejectedValue(new Error('Error'));
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(4);
      mockUserHostingService.cleanupActivity.mockResolvedValue(2);
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
