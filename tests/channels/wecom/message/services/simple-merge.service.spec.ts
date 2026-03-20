import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { SimpleMergeService } from '@wecom/message/services/simple-merge.service';
import { RedisService } from '@infra/redis/redis.service';
import { SystemConfigService } from '@biz/hosting-config/services/system-config.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';

describe('SimpleMergeService', () => {
  let service: SimpleMergeService;

  const mockJob = {
    getState: jest.fn(),
    remove: jest.fn(),
  };

  const mockMessageQueue = {
    getJob: jest.fn(),
    add: jest.fn(),
  };

  const mockRedisService = {
    rpush: jest.fn(),
    expire: jest.fn(),
    llen: jest.fn(),
    lrange: jest.fn(),
    ltrim: jest.fn(),
    getClient: jest.fn(),
  };

  const mockSystemConfigService = {
    onAgentReplyConfigChange: jest.fn(),
    getAgentReplyConfig: jest.fn(),
  };

  const validMessageData: EnterpriseMessageCallbackDto = {
    orgId: 'org-123',
    token: 'token-123',
    botId: 'bot-123',
    imBotId: 'wxid-bot-123',
    chatId: 'chat-123',
    messageType: MessageType.TEXT,
    messageId: 'msg-123',
    timestamp: '1234567890',
    isSelf: false,
    source: MessageSource.MOBILE_PUSH,
    contactType: ContactType.PERSONAL_WECHAT,
    payload: { text: 'Hello!' },
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SimpleMergeService,
        { provide: RedisService, useValue: mockRedisService },
        { provide: SystemConfigService, useValue: mockSystemConfigService },
        {
          provide: getQueueToken('message-merge'),
          useValue: mockMessageQueue,
        },
      ],
    }).compile();

    service = module.get<SimpleMergeService>(SimpleMergeService);
    jest.clearAllMocks();

    // Default setup
    mockSystemConfigService.onAgentReplyConfigChange.mockImplementation(() => {});
    mockSystemConfigService.getAgentReplyConfig.mockResolvedValue({
      initialMergeWindowMs: 2000,
      maxMergedMessages: 5,
    });
    mockRedisService.rpush.mockResolvedValue(1);
    mockRedisService.expire.mockResolvedValue(1);
    mockRedisService.llen.mockResolvedValue(1);
    mockRedisService.ltrim.mockResolvedValue(undefined);
    mockRedisService.getClient.mockReturnValue({
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    });
    mockMessageQueue.getJob.mockResolvedValue(null);
    mockMessageQueue.add.mockResolvedValue({ id: 'job-123' });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should load config from Supabase on init', async () => {
      mockSystemConfigService.getAgentReplyConfig.mockResolvedValue({
        initialMergeWindowMs: 3000,
        maxMergedMessages: 8,
      });

      await service.onModuleInit();

      expect(mockSystemConfigService.getAgentReplyConfig).toHaveBeenCalled();
    });

    it('should use default values when config load fails', async () => {
      mockSystemConfigService.getAgentReplyConfig.mockRejectedValue(
        new Error('Config load failed'),
      );

      await expect(service.onModuleInit()).resolves.not.toThrow();
    });
  });

  describe('addMessage', () => {
    it('should push message to Redis and create delayed job', async () => {
      mockMessageQueue.getJob.mockResolvedValue(null);
      mockRedisService.llen.mockResolvedValue(1);

      await service.addMessage(validMessageData);

      expect(mockRedisService.rpush).toHaveBeenCalled();
      expect(mockRedisService.expire).toHaveBeenCalled();
      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          delay: expect.any(Number),
        }),
      );
    });

    it('should remove waiting job and create new one for fresh delay', async () => {
      mockJob.getState.mockResolvedValue('waiting');
      mockJob.remove.mockResolvedValue(undefined);
      mockMessageQueue.getJob.mockResolvedValue(mockJob);
      mockRedisService.llen.mockResolvedValue(1);

      await service.addMessage(validMessageData);

      expect(mockJob.remove).toHaveBeenCalled();
      expect(mockMessageQueue.add).toHaveBeenCalled();
    });

    it('should remove delayed job and create new one', async () => {
      mockJob.getState.mockResolvedValue('delayed');
      mockJob.remove.mockResolvedValue(undefined);
      mockMessageQueue.getJob.mockResolvedValue(mockJob);
      mockRedisService.llen.mockResolvedValue(2);

      await service.addMessage(validMessageData);

      expect(mockJob.remove).toHaveBeenCalled();
    });

    it('should create new job with unique ID when existing job is active', async () => {
      mockJob.getState.mockResolvedValue('active');
      mockMessageQueue.getJob.mockResolvedValue(mockJob);
      mockRedisService.llen.mockResolvedValue(1);

      await service.addMessage(validMessageData);

      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          jobId: expect.stringContaining('chat-123:pending:'),
        }),
      );
    });

    it('should set delay=0 when queue is full', async () => {
      mockMessageQueue.getJob.mockResolvedValue(null);
      mockRedisService.llen.mockResolvedValue(5); // maxMergedMessages default is 5

      await service.onModuleInit(); // Initialize config

      await service.addMessage(validMessageData);

      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        expect.any(Object),
        expect.objectContaining({ delay: 0 }),
      );
    });

    it('should handle job creation failure gracefully', async () => {
      mockMessageQueue.getJob.mockRejectedValue(new Error('Queue error'));

      await expect(service.addMessage(validMessageData)).resolves.not.toThrow();
    });
  });

  describe('getAndClearPendingMessages', () => {
    it('should return parsed messages and batch ID', async () => {
      const rawMessages = [
        JSON.stringify(validMessageData),
        JSON.stringify({ ...validMessageData, messageId: 'msg-456' }),
      ];
      mockRedisService.lrange.mockResolvedValue(rawMessages);

      const result = await service.getAndClearPendingMessages('chat-123');

      expect(result.messages).toHaveLength(2);
      expect(result.batchId).toMatch(/^batch_chat-123_\d+$/);
      expect(mockRedisService.ltrim).toHaveBeenCalledWith(
        'wecom:message:pending:chat-123',
        2,
        -1,
      );
    });

    it('should return empty messages and empty batchId when queue is empty', async () => {
      mockRedisService.lrange.mockResolvedValue([]);

      const result = await service.getAndClearPendingMessages('chat-empty');

      expect(result.messages).toHaveLength(0);
      expect(result.batchId).toBe('');
    });

    it('should skip malformed JSON messages', async () => {
      mockRedisService.lrange.mockResolvedValue([
        JSON.stringify(validMessageData),
        'invalid-json-{{{',
      ]);

      const result = await service.getAndClearPendingMessages('chat-123');

      expect(result.messages).toHaveLength(1);
    });

    it('should handle already-parsed objects in lrange result', async () => {
      // Simulate when Redis returns object instead of string
      mockRedisService.lrange.mockResolvedValue([validMessageData]);

      const result = await service.getAndClearPendingMessages('chat-123');

      expect(result.messages).toHaveLength(1);
    });
  });

  describe('checkAndProcessNewMessages', () => {
    it('should create immediate job when pending messages exist', async () => {
      mockRedisService.llen.mockResolvedValue(3);
      mockMessageQueue.add.mockResolvedValue({ id: 'retry-job' });

      const result = await service.checkAndProcessNewMessages('chat-123');

      expect(result).toBe(true);
      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          delay: 0,
          jobId: expect.stringContaining('chat-123:retry:'),
        }),
      );
    });

    it('should return false when no pending messages', async () => {
      mockRedisService.llen.mockResolvedValue(0);

      const result = await service.checkAndProcessNewMessages('chat-empty');

      expect(result).toBe(false);
      expect(mockMessageQueue.add).not.toHaveBeenCalled();
    });

    it('should return false when job creation fails', async () => {
      mockRedisService.llen.mockResolvedValue(2);
      mockMessageQueue.add.mockRejectedValue(new Error('Queue error'));

      const result = await service.checkAndProcessNewMessages('chat-error');

      expect(result).toBe(false);
    });
  });

  describe('getStats', () => {
    it('should return current merge configuration stats', () => {
      const stats = service.getStats();

      expect(stats).toMatchObject({
        mergeDelayMs: expect.any(Number),
        maxMergedMessages: expect.any(Number),
      });
    });
  });
});
