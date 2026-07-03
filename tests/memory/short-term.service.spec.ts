import { ShortTermService } from '@memory/services/short-term.service';
import { buildChatHistoryCacheKey } from '@biz/message/utils/chat-history-cache.util';

describe('ShortTermService', () => {
  const mockRepo = {
    getChatHistory: jest.fn(),
  };

  const mockRedis = {
    lrange: jest.fn(),
    del: jest.fn(),
    rpush: jest.fn(),
    expire: jest.fn(),
    ltrim: jest.fn(),
    setex: jest.fn(),
  };

  const mockConfig = {
    sessionWindowMaxMessages: 60,
    sessionWindowMaxChars: 100, // small for testing trim
    sessionTtlDays: 1,
  };

  let service: ShortTermService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ShortTermService(mockRepo as never, mockConfig as never, mockRedis as never);
  });

  it('should return empty array when repo returns empty', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.getMessages('chat_1');

    expect(result).toEqual([]);
    expect(mockRepo.getChatHistory).toHaveBeenCalledWith(
      'chat_1',
      60,
      expect.objectContaining({ startTimeInclusive: expect.any(Number) }),
    );
  });

  it('should inject time context into messages', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      { messageId: 'm1', role: 'user', content: '你好', timestamp: 1710900000000 },
    ]);

    const result = await service.getMessages('chat_1');

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toContain('你好');
    expect(result[0].content).toContain('[消息发送时间');
  });

  it('should trim messages when exceeding char limit', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      { messageId: 'm1', role: 'user', content: 'A'.repeat(60), timestamp: 1710900000000 },
      {
        messageId: 'm2',
        role: 'assistant',
        content: 'B'.repeat(60),
        timestamp: 1710900001000,
      },
      { messageId: 'm3', role: 'user', content: 'C'.repeat(30), timestamp: 1710900002000 },
    ]);

    const result = await service.getMessages('chat_1');

    // With time context added, each message is longer than raw content.
    // The trim should keep the most recent messages within 100 chars.
    // At minimum, the last message should be kept.
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result[result.length - 1].content).toContain('C');
  });

  it('should return empty array on error', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockRejectedValue(new Error('db error'));

    const result = await service.getMessages('chat_1');

    expect(result).toEqual([]);
    expect(service.lastLoadError).toBe('db error');
  });

  it('should prefer redis cache over db history', async () => {
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'm1',
        role: 'user',
        content: '缓存消息',
        timestamp: 1710900000000,
      }),
    ]);

    const result = await service.getMessages('chat_1');

    expect(mockRedis.lrange).toHaveBeenCalledWith(buildChatHistoryCacheKey('chat_1'), 0, -1);
    expect(mockRepo.getChatHistory).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('缓存消息');
  });

  it('should filter cached messages after the inclusive cutoff', async () => {
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'm1',
        role: 'user',
        content: '本批消息',
        timestamp: 1710900000000,
      }),
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'm2',
        role: 'user',
        content: '下一批 pending',
        timestamp: 1710900001000,
      }),
    ]);

    const result = await service.getMessages('chat_1', {
      endTimeInclusive: 1710900000000,
    });

    expect(mockRepo.getChatHistory).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('本批消息');
    expect(result[0].content).not.toContain('下一批 pending');
  });

  it('should pass the inclusive cutoff to db history on cache miss', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    await service.getMessages('chat_1', {
      endTimeInclusive: 1710900000000,
    });

    expect(mockRepo.getChatHistory).toHaveBeenCalledWith(
      'chat_1',
      60,
      expect.objectContaining({
        startTimeInclusive: expect.any(Number),
        endTimeInclusive: 1710900000000,
      }),
    );
  });

  it('should use historyWindowSeconds (not sessionTtl) for Supabase startTimeInclusive', async () => {
    const HISTORY_WINDOW_SECONDS = 7 * 86400; // 7 days
    const SESSION_TTL = 86400; // 1 day — different from history window
    const customConfig = {
      sessionWindowMaxMessages: 60,
      sessionWindowMaxChars: 100000,
      historyWindowSeconds: HISTORY_WINDOW_SECONDS,
      sessionTtl: SESSION_TTL,
    };
    const customService = new ShortTermService(
      mockRepo as never,
      customConfig as never,
      mockRedis as never,
    );

    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    const before = Date.now();
    await customService.getMessages('chat_custom');
    const after = Date.now();

    const call = mockRepo.getChatHistory.mock.calls[0];
    const { startTimeInclusive } = call[2] as { startTimeInclusive: number };

    // startTimeInclusive should be ≈ now - 7 days, not now - 1 day
    const expectedMin = before - HISTORY_WINDOW_SECONDS * 1000;
    const expectedMax = after - HISTORY_WINDOW_SECONDS * 1000;
    expect(startTimeInclusive).toBeGreaterThanOrEqual(expectedMin);
    expect(startTimeInclusive).toBeLessThanOrEqual(expectedMax);

    // Sanity-check: it is NOT derived from SESSION_TTL (1 day)
    const oneDay = SESSION_TTL * 1000;
    const sevenDays = HISTORY_WINDOW_SECONDS * 1000;
    const distanceFromNow = after - startTimeInclusive;
    expect(distanceFromNow).toBeGreaterThan(oneDay); // not 1-day window
    expect(distanceFromNow).toBeLessThanOrEqual(sevenDays + 1000); // ≤ 7-day window
  });

  it('should clear lastLoadError after a successful reload', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockRejectedValueOnce(new Error('db error')).mockResolvedValueOnce([]);

    await service.getMessages('chat_1');
    expect(service.lastLoadError).toBe('db error');

    await service.getMessages('chat_1');
    expect(service.lastLoadError).toBeNull();
  });
});
