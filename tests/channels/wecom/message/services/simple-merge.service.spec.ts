import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { RedisService } from '@infra/redis/redis.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { MessageRuntimeConfigService } from '@wecom/message/runtime/message-runtime-config.service';

describe('SimpleMergeService', () => {
  let service: SimpleMergeService;

  const mockMessageQueue = {
    add: jest.fn(),
  };

  const mockRedisService = {
    setex: jest.fn(),
    get: jest.fn(),
    rpush: jest.fn(),
    expire: jest.fn(),
    llen: jest.fn(),
    lrange: jest.fn(),
    ltrim: jest.fn(),
    getClient: jest.fn(),
  };

  const mockRuntimeConfigService = {
    getMergeDelayMs: jest.fn(),
    syncSnapshot: jest.fn().mockResolvedValue(undefined),
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
        { provide: MessageRuntimeConfigService, useValue: mockRuntimeConfigService },
        {
          provide: getQueueToken('message-merge'),
          useValue: mockMessageQueue,
        },
      ],
    }).compile();

    service = module.get<SimpleMergeService>(SimpleMergeService);
    jest.clearAllMocks();

    // Default setup
    mockRuntimeConfigService.getMergeDelayMs.mockReturnValue(2000);
    mockRedisService.setex.mockResolvedValue(undefined);
    mockRedisService.get.mockResolvedValue(String(Date.now() - 3000));
    mockRedisService.rpush.mockResolvedValue(1);
    mockRedisService.expire.mockResolvedValue(1);
    mockRedisService.llen.mockResolvedValue(1);
    mockRedisService.ltrim.mockResolvedValue(undefined);
    mockRedisService.getClient.mockReturnValue({
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    });
    mockMessageQueue.add.mockResolvedValue({ id: 'job-123' });
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('onModuleInit', () => {
    it('should read merge delay from runtime config on init', async () => {
      mockRuntimeConfigService.getMergeDelayMs.mockReturnValue(3000);

      await service.onModuleInit();

      expect(mockRuntimeConfigService.getMergeDelayMs).toHaveBeenCalled();
    });
  });

  describe('addMessage', () => {
    it('should push message to Redis and create delayed job', async () => {
      mockRedisService.llen.mockResolvedValue(1);

      await service.addMessage(validMessageData);

      expect(mockRedisService.rpush).toHaveBeenCalled();
      expect(mockRedisService.expire).toHaveBeenCalled();
      expect(mockRedisService.setex).toHaveBeenCalledWith(
        'wecom:message:last-message-at:chat-123',
        300,
        expect.any(String),
      );
      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          delay: 2000,
          jobId: 'chat-123:msg-123',
        }),
      );
    });

    it('should create independent delayed checks for each new message', async () => {
      mockRedisService.llen.mockResolvedValue(2);

      await service.addMessage(validMessageData);
      await service.addMessage({ ...validMessageData, messageId: 'msg-456' });

      expect(mockMessageQueue.add).toHaveBeenNthCalledWith(
        1,
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({ jobId: 'chat-123:msg-123', delay: 2000 }),
      );
      expect(mockMessageQueue.add).toHaveBeenNthCalledWith(
        2,
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({ jobId: 'chat-123:msg-456', delay: 2000 }),
      );
    });

    it('should handle job creation failure gracefully', async () => {
      mockMessageQueue.add.mockRejectedValue(new Error('Queue error'));

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
    it('should create follow-up job using remaining quiet window', async () => {
      mockRedisService.llen.mockResolvedValue(3);
      mockRedisService.get.mockResolvedValue(String(Date.now() - 500));
      mockMessageQueue.add.mockResolvedValue({ id: 'retry-job' });

      const result = await service.checkAndProcessNewMessages('chat-123');

      expect(result).toBe(true);
      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          delay: expect.any(Number),
          jobId: expect.stringContaining('chat-123:followup:'),
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

  describe('isQuietWindowElapsed', () => {
    it('should return false when the last message is still within quiet window', async () => {
      mockRedisService.get.mockResolvedValue(String(Date.now() - 500));

      const result = await service.isQuietWindowElapsed('chat-123');

      expect(result).toBe(false);
    });

    it('should return true when the quiet window has elapsed', async () => {
      mockRedisService.get.mockResolvedValue(String(Date.now() - 3000));

      const result = await service.isQuietWindowElapsed('chat-123');

      expect(result).toBe(true);
    });
  });

  describe('getStats', () => {
    it('should return current merge configuration stats', () => {
      const stats = service.getStats();

      expect(stats).toMatchObject({
        mergeDelayMs: expect.any(Number),
      });
    });
  });
});
