import { MessageTraceStoreService } from '@channels/wecom/message/telemetry/message-trace-store.service';
import { RedisKeyBuilder } from '@channels/wecom/message/runtime/redis-key.util';

describe('MessageTraceStoreService', () => {
  const redisService = {
    get: jest.fn(),
    hgetall: jest.fn(),
    hmget: jest.fn(),
    hset: jest.fn(),
    expire: jest.fn(),
    exists: jest.fn(),
    eval: jest.fn(),
    del: jest.fn(),
  };

  let service: MessageTraceStoreService;

  beforeEach(() => {
    jest.clearAllMocks();
    redisService.hgetall.mockResolvedValue(null);
    service = new MessageTraceStoreService(redisService as never);
  });

  it('should parse serialized traces from redis', async () => {
    redisService.get.mockResolvedValueOnce(JSON.stringify({ phase: 'worker', ok: true }));

    await expect(service.get<{ phase: string; ok: boolean }>('msg-1')).resolves.toEqual({
      phase: 'worker',
      ok: true,
    });
    expect(redisService.get).toHaveBeenCalledWith(RedisKeyBuilder.trace('msg-1'));
  });

  it('should persist traces as a field-level V2 hash with the expected ttl', async () => {
    await service.set('msg-2', { phase: 'ai', timings: { acceptedAt: 123 } });

    expect(redisService.hset).toHaveBeenCalledWith(`${RedisKeyBuilder.trace('msg-2')}:v2`, {
      phase: 'ai',
      'timing:acceptedAt': 123,
      _traceSchema: 2,
    });
    expect(redisService.expire).toHaveBeenCalledWith(
      `${RedisKeyBuilder.trace('msg-2')}:v2`,
      24 * 60 * 60,
    );
  });

  it('should inflate V2 hash timing fields without reading the legacy JSON key', async () => {
    redisService.hgetall.mockResolvedValueOnce({
      _traceSchema: 2,
      request: { chatId: 'chat-1' },
      'timing:acceptedAt': 123,
      'timing:aiStartAt': 456,
    });

    await expect(service.get('msg-v2')).resolves.toEqual({
      request: { chatId: 'chat-1' },
      timings: { acceptedAt: 123, aiStartAt: 456 },
    });
    expect(redisService.get).not.toHaveBeenCalled();
  });

  it('should delete trace keys from redis', async () => {
    await service.delete('msg-3');

    expect(redisService.del).toHaveBeenCalledWith(
      `${RedisKeyBuilder.trace('msg-3')}:v2`,
      RedisKeyBuilder.trace('msg-3'),
    );
  });
});
