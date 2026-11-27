import {
  PhoneSessionIndexService,
  isNonProductionSessionRef,
} from '@memory/phone-session-index.service';

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
      'oob:phone:bot-1:18271421690',
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

  it('补齐长期记忆账号键时不受旧索引的一小时去重阻挡', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    await service.record('18271421690', ref);
    await service.record('18271421690', { ...ref, botUserId: 'wecom-A' });
    expect(redis.setex).toHaveBeenCalledTimes(4);
    expect(redis.setex).toHaveBeenLastCalledWith(
      'oob:chat:chat-1',
      30 * 24 * 60 * 60,
      expect.objectContaining({ botImId: 'bot-1', botUserId: 'wecom-A' }),
    );
  });

  it.each([
    ['corpId=test', { ...ref, corpId: 'test' }],
    ['corpId=debug', { ...ref, corpId: 'debug' }],
    ['chatId test-*', { ...ref, chatId: 'test-abc' }],
    ['chatId p1-fixed-*', { ...ref, chatId: 'p1-fixed-1' }],
    ['chatId p2-fixed-*', { ...ref, chatId: 'p2-fixed-1' }],
    ['chatId p3-fixed-*', { ...ref, chatId: 'p3-fixed-1' }],
  ])('测试/调试链路会话（%s）兜底不写索引', async (_label, testRef) => {
    const service = new PhoneSessionIndexService(redis as never);
    await service.record('18271421690', testRef);
    expect(redis.setex).not.toHaveBeenCalled();
    expect(isNonProductionSessionRef(testRef)).toBe(true);
    expect(isNonProductionSessionRef(ref)).toBe(false);
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
    await expect(service.lookupByPhone('18271421690', ref.botImId)).resolves.toMatchObject({
      chatId: 'chat-1',
      phone: '18271421690',
    });
    expect(redis.get).toHaveBeenCalledWith('oob:phone:bot-1:18271421690');

    redis.get.mockResolvedValueOnce({ junk: true });
    await expect(service.lookupByChat('chat-1')).resolves.toBeNull();

    redis.get.mockRejectedValueOnce(new Error('redis down'));
    await expect(service.lookupByChat('chat-1')).resolves.toBeNull();
    await expect(service.lookupByPhone('bad', ref.botImId)).resolves.toBeNull();
  });
  it('同一手机号可以分别找到两个托管号下的会话，旧索引仍能读取', async () => {
    const entries = new Map();
    redis.setex.mockImplementation(async (key, _ttl, record) => entries.set(key, record));
    redis.get.mockImplementation(async (key) => entries.get(key));
    const service = new PhoneSessionIndexService(redis as never);
    const phone = '18271421690';
    await service.record(phone, ref);
    await service.record(phone, { ...ref, botImId: 'bot-2', chatId: 'chat-2' });
    expect((await service.lookupByPhone(phone, 'bot-1'))?.chatId).toBe('chat-1');
    expect((await service.lookupByPhone(phone, 'bot-2'))?.chatId).toBe('chat-2');
    entries.set('oob:phone:' + phone, { ...ref, phone, botImId: 'legacy-bot' });
    expect((await service.lookupByPhone(phone, 'legacy-bot'))?.botImId).toBe('legacy-bot');
  });

  it('strict repair propagates index failure and permits a later local-only retry', async () => {
    const service = new PhoneSessionIndexService(redis as never);
    redis.setex.mockRejectedValueOnce(new Error('redis unavailable'));
    await expect(service.record('18271421690', ref, { strict: true })).rejects.toThrow(
      'redis unavailable',
    );
    await expect(service.record('18271421690', ref, { strict: true })).resolves.toBeUndefined();
    expect(redis.setex).toHaveBeenCalledTimes(4);
  });
});
