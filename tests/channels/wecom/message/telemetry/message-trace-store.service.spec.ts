import { MessageTraceStoreService } from '@channels/wecom/message/telemetry/message-trace-store.service';
import { RedisKeyBuilder } from '@channels/wecom/message/runtime/redis-key.util';

describe('MessageTraceStoreService', () => {
  const redisService = {
    get: jest.fn(),
    setex: jest.fn(),
    del: jest.fn(),
  };

  let service: MessageTraceStoreService;

  beforeEach(() => {
    jest.clearAllMocks();
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

  it('should persist traces with the expected ttl', async () => {
    await service.set('msg-2', { phase: 'ai' });

    expect(redisService.setex).toHaveBeenCalledWith(
      RedisKeyBuilder.trace('msg-2'),
      24 * 60 * 60,
      JSON.stringify({ phase: 'ai' }),
    );
  });

  it('should delete trace keys from redis', async () => {
    await service.delete('msg-3');

    expect(redisService.del).toHaveBeenCalledWith(RedisKeyBuilder.trace('msg-3'));
  });
});
