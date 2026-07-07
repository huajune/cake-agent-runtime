import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { DataCleanupService } from '@biz/monitoring/services/cleanup/data-cleanup.service';
import { SupabaseService } from '@infra/supabase/supabase.service';
import { ChatSessionService } from '@biz/message/services/chat-session.service';
import { GuardrailReviewService } from '@biz/message/services/guardrail-review.service';
import { MessageProcessingService } from '@biz/message/services/message-processing.service';
import { AgentExecutionEventRepository } from '@biz/monitoring/repositories/agent-execution-event.repository';
import { MonitoringErrorLogRepository } from '@biz/monitoring/repositories/error-log.repository';
import { ReengagementTouchRepository } from '@biz/monitoring/repositories/reengagement-touch.repository';
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
    timeoutStuckRecords: jest.fn(),
    interruptStalePostProcessing: jest.fn().mockResolvedValue(0),
  };

  const mockGuardrailReviewService = {
    cleanupExpiredReviews: jest.fn(),
  };

  const mockAgentExecutionEventRepository = {
    cleanupExpiredEvents: jest.fn(),
  };

  const mockUserHostingService = {
    cleanupActivity: cleanupActivityMock,
    cleanupUserActivity: cleanupActivityMock,
  };

  const mockErrorLogRepository = {
    cleanupErrorLogs: jest.fn(),
  };

  const mockReengagementTouchRepository = {
    nullExpiredGeneratedText: jest.fn().mockResolvedValue(0),
    cleanupExpiredRecords: jest.fn().mockResolvedValue(0),
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
          provide: GuardrailReviewService,
          useValue: mockGuardrailReviewService,
        },
        {
          provide: UserHostingService,
          useValue: mockUserHostingService,
        },
        {
          provide: AgentExecutionEventRepository,
          useValue: mockAgentExecutionEventRepository,
        },
        {
          provide: MonitoringErrorLogRepository,
          useValue: mockErrorLogRepository,
        },
        {
          provide: ReengagementTouchRepository,
          useValue: mockReengagementTouchRepository,
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
      mockGuardrailReviewService.cleanupExpiredReviews.mockResolvedValue(4);
      mockAgentExecutionEventRepository.cleanupExpiredEvents.mockResolvedValue(6);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(5);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(3);
      mockUserHostingService.cleanupActivity.mockResolvedValue(2);

      await service.cleanupExpiredData();

      // 1. NULL agent_invocation (>7 天)
      expect(messageProcessingService.nullAgentInvocations).toHaveBeenCalledWith(7);
      // 2. DELETE chat_messages (>60 天)
      expect(chatSessionService.cleanupChatMessages).toHaveBeenCalledWith(60);
      // 3. DELETE guardrail_review_records (>60 天，默认跟随 DATA_CLEANUP_PROCESSING_DAYS)
      expect(mockGuardrailReviewService.cleanupExpiredReviews).toHaveBeenCalledWith(60);
      // 4. DELETE agent_execution_events (>60 天，默认跟随 DATA_CLEANUP_PROCESSING_DAYS)
      expect(mockAgentExecutionEventRepository.cleanupExpiredEvents).toHaveBeenCalledWith(60);
      // 5. DELETE message_processing_records (>60 天，默认 DATA_CLEANUP_PROCESSING_DAYS)
      expect(messageProcessingService.cleanupRecords).toHaveBeenCalledWith(60);
      // 6. DELETE monitoring_error_logs (>30 天)
      expect(mockErrorLogRepository.cleanupErrorLogs).toHaveBeenCalledWith(30);
      // 7. DELETE user_activity (>365 天)
      expect(mockUserHostingService.cleanupActivity).toHaveBeenCalledWith(365);
      // 8. reengagement_touch_records: NULL generated_text (>30 天) + DELETE (>90 天)
      expect(mockReengagementTouchRepository.nullExpiredGeneratedText).toHaveBeenCalledWith(30);
      expect(mockReengagementTouchRepository.cleanupExpiredRecords).toHaveBeenCalledWith(90);
    });

    it('should skip cleanup when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      await service.cleanupExpiredData();

      expect(messageProcessingService.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatSessionService.cleanupChatMessages).not.toHaveBeenCalled();
      expect(mockGuardrailReviewService.cleanupExpiredReviews).not.toHaveBeenCalled();
      expect(mockAgentExecutionEventRepository.cleanupExpiredEvents).not.toHaveBeenCalled();
      expect(messageProcessingService.cleanupRecords).not.toHaveBeenCalled();
      expect(mockErrorLogRepository.cleanupErrorLogs).not.toHaveBeenCalled();
      expect(mockUserHostingService.cleanupActivity).not.toHaveBeenCalled();
      expect(mockReengagementTouchRepository.nullExpiredGeneratedText).not.toHaveBeenCalled();
      expect(mockReengagementTouchRepository.cleanupExpiredRecords).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully during agent_invocation cleanup', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockRejectedValue(
        new Error('Database error'),
      );
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(0);
      mockGuardrailReviewService.cleanupExpiredReviews.mockResolvedValue(0);
      mockAgentExecutionEventRepository.cleanupExpiredEvents.mockResolvedValue(0);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(0);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(0);

      // Should not throw
      await expect(service.cleanupExpiredData()).resolves.not.toThrow();
      // Should continue to next steps even after error
      expect(chatSessionService.cleanupChatMessages).toHaveBeenCalled();
    });

    it('should continue deleting expired touch rows when generated_text nulling fails', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(0);
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(0);
      mockGuardrailReviewService.cleanupExpiredReviews.mockResolvedValue(0);
      mockAgentExecutionEventRepository.cleanupExpiredEvents.mockResolvedValue(0);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(0);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(0);
      mockUserHostingService.cleanupActivity.mockResolvedValue(0);
      mockReengagementTouchRepository.nullExpiredGeneratedText.mockRejectedValueOnce(
        new Error('DB error'),
      );
      mockReengagementTouchRepository.cleanupExpiredRecords.mockResolvedValueOnce(4);

      await expect(service.cleanupExpiredData()).resolves.not.toThrow();

      expect(mockReengagementTouchRepository.cleanupExpiredRecords).toHaveBeenCalledWith(90);
    });
  });

  describe('timeoutStuckRecordsHourly', () => {
    it('should mark stuck processing records as timeout (>30 min)', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.timeoutStuckRecords.mockResolvedValue(3);

      await service.timeoutStuckRecordsHourly();

      expect(mockMessageProcessingService.timeoutStuckRecords).toHaveBeenCalledWith(30);
    });

    it('should skip when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      await service.timeoutStuckRecordsHourly();

      expect(mockMessageProcessingService.timeoutStuckRecords).not.toHaveBeenCalled();
    });

    it('should swallow repository errors', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.timeoutStuckRecords.mockRejectedValue(new Error('DB error'));

      await expect(service.timeoutStuckRecordsHourly()).resolves.not.toThrow();
    });

    it('should also sweep stale running post-processing as interrupted', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.timeoutStuckRecords.mockResolvedValue(0);
      mockMessageProcessingService.interruptStalePostProcessing.mockResolvedValue(2);

      await service.timeoutStuckRecordsHourly();

      expect(mockMessageProcessingService.interruptStalePostProcessing).toHaveBeenCalledWith(30);
    });

    it('should swallow interruptStalePostProcessing errors', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.timeoutStuckRecords.mockResolvedValue(0);
      mockMessageProcessingService.interruptStalePostProcessing.mockRejectedValue(
        new Error('DB error'),
      );

      await expect(service.timeoutStuckRecordsHourly()).resolves.not.toThrow();
    });
  });

  describe('triggerCleanup', () => {
    it('should return cleanup counts when Supabase is available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(20);
      mockChatSessionService.cleanupChatMessages.mockResolvedValue(15);
      mockGuardrailReviewService.cleanupExpiredReviews.mockResolvedValue(7);
      mockAgentExecutionEventRepository.cleanupExpiredEvents.mockResolvedValue(9);
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(8);
      mockUserHostingService.cleanupActivity.mockResolvedValue(3);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(5);
      mockReengagementTouchRepository.nullExpiredGeneratedText.mockResolvedValueOnce(6);
      mockReengagementTouchRepository.cleanupExpiredRecords.mockResolvedValueOnce(2);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 20,
        chatMessages: 15,
        guardrailReviewRecords: 7,
        agentExecutionEvents: 9,
        processingRecords: 8,
        userActivity: 3,
        errorLogs: 5,
        reengagementTouchTexts: 6,
        reengagementTouchRecords: 2,
      });
    });

    it('should return zeros when Supabase is not available', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(false);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 0,
        chatMessages: 0,
        guardrailReviewRecords: 0,
        agentExecutionEvents: 0,
        processingRecords: 0,
        userActivity: 0,
        errorLogs: 0,
        reengagementTouchTexts: 0,
        reengagementTouchRecords: 0,
      });
      expect(messageProcessingService.nullAgentInvocations).not.toHaveBeenCalled();
      expect(chatSessionService.cleanupChatMessages).not.toHaveBeenCalled();
      expect(mockGuardrailReviewService.cleanupExpiredReviews).not.toHaveBeenCalled();
      expect(mockAgentExecutionEventRepository.cleanupExpiredEvents).not.toHaveBeenCalled();
      expect(mockReengagementTouchRepository.nullExpiredGeneratedText).not.toHaveBeenCalled();
    });

    it('should handle partial failures gracefully', async () => {
      mockSupabaseService.isAvailable.mockReturnValue(true);
      mockMessageProcessingService.nullAgentInvocations.mockResolvedValue(10);
      mockChatSessionService.cleanupChatMessages.mockRejectedValue(new Error('Error'));
      mockGuardrailReviewService.cleanupExpiredReviews.mockRejectedValue(new Error('Error'));
      mockAgentExecutionEventRepository.cleanupExpiredEvents.mockRejectedValue(new Error('Error'));
      mockMessageProcessingService.cleanupRecords.mockResolvedValue(4);
      mockUserHostingService.cleanupActivity.mockResolvedValue(2);
      mockErrorLogRepository.cleanupErrorLogs.mockResolvedValue(1);
      mockReengagementTouchRepository.nullExpiredGeneratedText.mockRejectedValueOnce(
        new Error('Error'),
      );
      mockReengagementTouchRepository.cleanupExpiredRecords.mockResolvedValueOnce(3);

      const result = await service.triggerCleanup();

      expect(result).toEqual({
        agentInvocations: 10,
        chatMessages: 0,
        guardrailReviewRecords: 0,
        agentExecutionEvents: 0,
        processingRecords: 4,
        userActivity: 2,
        errorLogs: 1,
        reengagementTouchTexts: 0,
        reengagementTouchRecords: 3,
      });
    });
  });
});
