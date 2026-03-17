import { Test, TestingModule } from '@nestjs/testing';
import { MessageController } from '@wecom/message/message.controller';
import { MessageService } from '@wecom/message/message.service';
import { MessageProcessor } from '@wecom/message/message.processor';
import { MessageType, ContactType, MessageSource } from '@wecom/message/dto/message-callback.dto';
import { MessageCallbackAdapterService } from '@wecom/message/services/callback-adapter.service';
import { MessageFilterService } from '@wecom/message/services/filter.service';
import { GroupBlacklistService } from '@biz/hosting-config/services/group-blacklist.service';

describe('MessageController', () => {
  let controller: MessageController;
  let service: MessageService;

  const mockMessageService = {
    handleMessage: jest.fn(),
    handleSentResult: jest.fn(),
  };

  const mockCallbackAdapterService = {
    detectCallbackType: jest.fn().mockReturnValue('enterprise'),
    normalizeCallback: jest.fn().mockImplementation((body) => body),
  };

  const mockFilterService = {
    shouldFilter: jest.fn().mockReturnValue(false),
    getFilterReason: jest.fn().mockReturnValue(null),
  };

  const mockGroupBlacklistService = {
    getGroupBlacklist: jest.fn().mockResolvedValue([]),
    addGroupToBlacklist: jest.fn().mockResolvedValue(undefined),
    removeGroupFromBlacklist: jest.fn().mockResolvedValue(true),
    isGroupBlacklisted: jest.fn().mockResolvedValue(false),
  };

  const mockMessageProcessor = {
    getQueueStatus: jest.fn().mockResolvedValue({
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      paused: 0,
    }),
    getWorkerStatus: jest.fn().mockReturnValue({
      concurrency: 1,
      activeJobs: 0,
      minConcurrency: 1,
      maxConcurrency: 20,
    }),
    cleanStuckJobs: jest.fn().mockResolvedValue({
      success: true,
      cleaned: { active: 0, failed: 0, completed: 0, delayed: 0 },
      message: 'Cleaned 0 jobs',
    }),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [MessageController],
      providers: [
        {
          provide: MessageService,
          useValue: mockMessageService,
        },
        {
          provide: MessageCallbackAdapterService,
          useValue: mockCallbackAdapterService,
        },
        {
          provide: MessageFilterService,
          useValue: mockFilterService,
        },
        {
          provide: GroupBlacklistService,
          useValue: mockGroupBlacklistService,
        },
        {
          provide: MessageProcessor,
          useValue: mockMessageProcessor,
        },
      ],
    }).compile();

    controller = module.get<MessageController>(MessageController);
    service = module.get<MessageService>(MessageService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('receiveMessage', () => {
    it('should call messageService.handleMessage with correct body', async () => {
      const mockBody = {
        orgId: 'test_org_123',
        token: 'test_token',
        botId: 'test_bot_123',
        imBotId: 'test_bot_wxid',
        chatId: 'test_chat_123',
        messageType: MessageType.TEXT,
        messageId: 'test_msg_123',
        timestamp: '1234567890',
        isSelf: false,
        source: MessageSource.NEW_CUSTOMER_ANSWER_SOP,
        contactType: ContactType.PERSONAL_WECHAT,
        payload: {
          text: 'test message',
        },
      };
      const mockResult = { success: true };

      mockMessageService.handleMessage.mockResolvedValue(mockResult);

      const result = await controller.receiveMessage(mockBody as any);

      expect(service.handleMessage).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle enterprise callback with all fields', async () => {
      const mockBody = {
        orgId: 'org_456',
        token: 'token_456',
        botId: 'bot_456',
        imBotId: 'wxid_456',
        chatId: 'chat_456',
        messageType: MessageType.TEXT,
        messageId: 'msg_456',
        timestamp: '9876543210',
        isSelf: false,
        source: MessageSource.MOBILE_PUSH,
        contactType: ContactType.ENTERPRISE_WECHAT,
        payload: {
          text: 'test message in group',
          mention: ['@all'],
        },
      };
      const mockResult = { success: true };

      mockMessageService.handleMessage.mockResolvedValue(mockResult);

      const result = await controller.receiveMessage(mockBody as any);

      expect(service.handleMessage).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from messageService.handleMessage', async () => {
      const mockBody = {
        orgId: 'test_org',
        token: 'test_token',
        botId: 'test_bot',
        imBotId: 'test_wxid',
        chatId: 'test_chat',
        messageType: MessageType.TEXT,
        messageId: 'test_msg',
        timestamp: '1234567890',
        isSelf: false,
        source: MessageSource.NEW_CUSTOMER_ANSWER_SOP,
        contactType: ContactType.PERSONAL_WECHAT,
        payload: { text: 'test' },
      };
      const error = new Error('Service error');

      mockMessageService.handleMessage.mockRejectedValue(error);

      await expect(controller.receiveMessage(mockBody as any)).rejects.toThrow('Service error');
    });
  });

  describe('receiveSentResult', () => {
    it('should call messageService.handleSentResult with correct body', async () => {
      const mockBody = {
        msgId: '123',
        status: 'success',
        timestamp: 1234567890,
      };
      const mockResult = { received: true };

      mockMessageService.handleSentResult.mockResolvedValue(mockResult);

      const result = await controller.receiveSentResult(mockBody);

      expect(service.handleSentResult).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle failed status in sent result', async () => {
      const mockBody = {
        msgId: '123',
        status: 'failed',
        error: 'Send failed',
      };
      const mockResult = { received: true };

      mockMessageService.handleSentResult.mockResolvedValue(mockResult);

      const result = await controller.receiveSentResult(mockBody);

      expect(service.handleSentResult).toHaveBeenCalledWith(mockBody);
      expect(result).toEqual(mockResult);
    });

    it('should handle errors from messageService.handleSentResult', async () => {
      const mockBody = { msgId: '123' };
      const error = new Error('Service error');

      mockMessageService.handleSentResult.mockRejectedValue(error);

      await expect(controller.receiveSentResult(mockBody)).rejects.toThrow('Service error');
    });
  });
});
