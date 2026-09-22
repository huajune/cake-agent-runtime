import { PhoneSessionIndexService } from '@memory/phone-session-index.service';

describe('PhoneSessionIndexService', () => {
  const redis = { setex: jest.fn(), get: jest.fn() };
  const ref = { corpId: 'corp-1', userId: 'user-1', chatId: 'chat-1', botImId: 'bot-1' };

  beforeEach(() => {
    jest.clearAllMocks();
    redis.setex.mockResolvedValue(undefined);
    redis.get.mockResolvedValue(null);
  });

  it('按手机号与会话各写一份索引，TTL 30 天', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    await service.record('18271421690', ref);

    expect(redis.setex).toHaveBeenCalledTimes(2);
    expect(redis.setex).toHaveBeenCalledWith(
      'oob:phone:18271421690',
      30 * 24 * 60 * 60,
      expect.objectContaining({ ...ref, phone: '18271421690' }),
    );
    expect(redis.setex).toHaveBeenCalledWith(
      'oob:chat:chat-1',
      30 * 24 * 60 * 60,
      expect.objectContaining({ phone: '18271421690' }),
    );
  });

  it('同手机号同会话一小时内只写一次；写失败允许重试', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    await service.record('18271421690', ref);
    await service.record('18271421690', ref);
    expect(redis.setex).toHaveBeenCalledTimes(2);

    redis.setex.mockRejectedValueOnce(new Error('redis down'));
    const other = new PhoneSessionIndexService(redis as never);
    await other.record('18271421690', ref);
    await other.record('18271421690', ref);
    // 第一次失败不占去重槽，第二次重写成功（2 次失败尝试中的 1 次 + 2 次成功）
    expect(redis.setex.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('非候选人号段不写索引', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    await service.record('10086', ref);
    await service.record('', ref);
    expect(redis.setex).not.toHaveBeenCalled();
  });

  it('按手机号/会话反查；结构不对或读失败返回 null', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    redis.get.mockResolvedValueOnce({ ...ref, phone: '18271421690', updatedAt: 1 });
    await expect(service.lookupByPhone('18271421690')).resolves.toMatchObject({
      chatId: 'chat-1',
      phone: '18271421690',
    });
    expect(redis.get).toHaveBeenCalledWith('oob:phone:18271421690');

    redis.get.mockResolvedValueOnce({ junk: true });
    await expect(service.lookupByChat('chat-1')).resolves.toBeNull();

    redis.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.lookupByChat('chat-1')).resolves.toBeNull();
    await expect(service.lookupByPhone('bad')).resolves.toBeNull();
  });
});
