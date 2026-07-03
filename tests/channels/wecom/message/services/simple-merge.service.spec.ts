import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bull';
import { SimpleMergeService } from '@wecom/message/runtime/simple-merge.service';
import { RedisService } from '@infra/redis/redis.service';
import { EnterpriseMessageCallbackDto } from '@wecom/message/ingress/message-callback.dto';
import { MessageType, ContactType, MessageSource } from '@enums/message-callback.enum';
import { MessageRuntimeConfigService } from '@wecom/message/runtime/message-runtime-config.service';
import { WecomMessageObservabilityService } from '@wecom/message/telemetry/wecom-message-observability.service';

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

  const mockWecomObservability = {
    markQueueAdd: jest.fn().mockResolvedValue(undefined),
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
        { provide: WecomMessageObservabilityService, useValue: mockWecomObservability },
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

    it('job 创建持续失败时重试若干次后上抛（不再静默吞掉，交由上游记录失败）', async () => {
      mockMessageQueue.add.mockRejectedValue(new Error('Queue error'));

      await expect(service.addMessage(validMessageData)).rejects.toThrow('Queue error');
      // 重试到上限：本地多次尝试都打到队列
      expect(mockMessageQueue.add).toHaveBeenCalledTimes(3);
    });

    it('job 创建瞬时失败后重试成功 → 不上抛', async () => {
      mockMessageQueue.add
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined);

      await expect(service.addMessage(validMessageData)).resolves.toBeUndefined();
      expect(mockMessageQueue.add).toHaveBeenCalledTimes(2);
    });
  });

  describe('claimPendingSnapshot', () => {
    it('should return parsed messages, snapshotSize and batchId without clearing pending', async () => {
      const rawMessages = [
        JSON.stringify(validMessageData),
        JSON.stringify({ ...validMessageData, messageId: 'msg-456' }),
      ];
      mockRedisService.lrange.mockResolvedValue(rawMessages);

      const result = await service.claimPendingSnapshot('chat-123');

      expect(result.messages).toHaveLength(2);
      expect(result.snapshotSize).toBe(2);
      expect(result.batchId).toMatch(/^batch_chat-123_\d+$/);
      expect(mockRedisService.lrange).toHaveBeenCalledWith('wecom:message:pending:chat-123', 0, -1);
      // 关键改动：claim 阶段不再 LTRIM，只有显式 ack 才裁掉
      expect(mockRedisService.ltrim).not.toHaveBeenCalled();
    });

    it('should support fromIndex for replay path and skip batchId generation', async () => {
      mockRedisService.lrange.mockResolvedValue([JSON.stringify(validMessageData)]);

      const result = await service.claimPendingSnapshot('chat-123', 2);

      expect(result.messages).toHaveLength(1);
      expect(result.snapshotSize).toBe(1);
      expect(result.batchId).toBe('');
      expect(mockRedisService.lrange).toHaveBeenCalledWith('wecom:message:pending:chat-123', 2, -1);
    });

    it('should return empty messages and snapshotSize=0 when queue is empty', async () => {
      mockRedisService.lrange.mockResolvedValue([]);

      const result = await service.claimPendingSnapshot('chat-empty');

      expect(result.messages).toHaveLength(0);
      expect(result.snapshotSize).toBe(0);
      expect(result.batchId).toBe('');
    });

    it('should skip malformed JSON messages but still count snapshotSize accurately', async () => {
      mockRedisService.lrange.mockResolvedValue([
        JSON.stringify(validMessageData),
        'invalid-json-{{{',
      ]);

      const result = await service.claimPendingSnapshot('chat-123');

      expect(result.messages).toHaveLength(1);
      // snapshotSize 反映原始条数，用于 ack 时正确 LTRIM 偏移
      expect(result.snapshotSize).toBe(2);
    });

    it('should handle already-parsed objects in lrange result', async () => {
      mockRedisService.lrange.mockResolvedValue([validMessageData]);

      const result = await service.claimPendingSnapshot('chat-123');

      expect(result.messages).toHaveLength(1);
      expect(result.snapshotSize).toBe(1);
    });
  });

  describe('ackPendingMessages', () => {
    it('should LTRIM the first count items from pending', async () => {
      await service.ackPendingMessages('chat-123', 3);

      expect(mockRedisService.ltrim).toHaveBeenCalledWith('wecom:message:pending:chat-123', 3, -1);
    });

    it('should be a no-op when count <= 0', async () => {
      await service.ackPendingMessages('chat-123', 0);
      await service.ackPendingMessages('chat-123', -1);

      expect(mockRedisService.ltrim).not.toHaveBeenCalled();
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

  describe('scheduleLockRetryCheck', () => {
    it('should refresh pending TTL and schedule a delayed re-check when pending exists', async () => {
      mockRedisService.llen.mockResolvedValue(2);

      await service.scheduleLockRetryCheck('chat-123');

      // 续期 pending / lastMessageAt，保证消息能活到孤悬锁过期之后
      expect(mockRedisService.expire).toHaveBeenCalledWith('wecom:message:pending:chat-123', 300);
      expect(mockRedisService.expire).toHaveBeenCalledWith(
        'wecom:message:last-message-at:chat-123',
        300,
      );
      expect(mockMessageQueue.add).toHaveBeenCalledWith(
        'process',
        { chatId: 'chat-123' },
        expect.objectContaining({
          delay: 30000,
          jobId: expect.stringContaining('chat-123:lockretry:'),
        }),
      );
    });

    it('should be a no-op when pending queue is empty', async () => {
      mockRedisService.llen.mockResolvedValue(0);

      await service.scheduleLockRetryCheck('chat-empty');

      expect(mockRedisService.expire).not.toHaveBeenCalled();
      expect(mockMessageQueue.add).not.toHaveBeenCalled();
    });

    it('should swallow queue errors instead of failing the caller', async () => {
      mockRedisService.llen.mockResolvedValue(1);
      mockMessageQueue.add.mockRejectedValue(new Error('Queue error'));

      await expect(service.scheduleLockRetryCheck('chat-err')).resolves.not.toThrow();
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
