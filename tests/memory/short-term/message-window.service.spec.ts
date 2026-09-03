import { MessageWindowService } from '@memory/short-term/message-window.service';
import { buildChatHistoryCacheKey } from '@memory/short-term/chat-history-cache.util';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

describe('MessageWindowService', () => {
  /** 相对当前时间取基准：缓存命中路径套 7 天窗口，固定的历史时间戳会被当过期裁掉。 */
  const BASE = Date.now() - 60_000;

  const mockRepo = {
    getChatHistory: jest.fn(),
  };

  const mockRedis = {
    lrange: jest.fn(),
    del: jest.fn(),
    eval: jest.fn(),
    rpush: jest.fn(),
    expire: jest.fn(),
    ltrim: jest.fn(),
    setex: jest.fn(),
  };

  const mockConfig = {
    sessionWindowMaxMessages: 60,
    sessionWindowMaxChars: 100, // small for testing trim
    sessionTtlDays: 1,
    sessionTtl: 86400,
    historyWindowSeconds: 7 * 86400,
  };

  /** 回填脚本 ARGV = [maxMessages, ttlSeconds, ...payloads]，取出 payload 段。 */
  const rebuildPayloads = (): string[] => {
    const [, , args] = mockRedis.eval.mock.calls[0] as [string, string[], (string | number)[]];
    return args.slice(2) as string[];
  };

  let service: MessageWindowService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MessageWindowService(mockRepo as never, mockConfig as never, mockRedis as never);
  });

  it('should return empty array when repo returns empty', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.getMessages('chat_1');

    expect(result).toEqual([]);
    expect(mockRepo.getChatHistory).toHaveBeenCalledWith('chat_1', 60);
  });

  it('should inject time context into messages', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      { messageId: 'm1', role: 'user', content: '你好', timestamp: BASE },
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
      { messageId: 'm1', role: 'user', content: 'A'.repeat(60), timestamp: BASE },
      {
        messageId: 'm2',
        role: 'assistant',
        content: 'B'.repeat(60),
        timestamp: BASE + 1000,
      },
      { messageId: 'm3', role: 'user', content: 'C'.repeat(30), timestamp: BASE + 2000 },
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
        timestamp: BASE,
        provenanceVersion: 2,
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
        timestamp: BASE,
        provenanceVersion: 2,
      }),
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'm2',
        role: 'user',
        content: '下一批 pending',
        timestamp: BASE + 1000,
        provenanceVersion: 2,
      }),
    ]);

    const result = await service.getMessages('chat_1', {
      endTimeInclusive: BASE,
    });

    expect(mockRepo.getChatHistory).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('本批消息');
    expect(result[0].content).not.toContain('下一批 pending');
  });

  it('should not push the inclusive cutoff down to db and filter only user messages in memory', async () => {
    const customService = new MessageWindowService(
      mockRepo as never,
      { ...mockConfig, sessionWindowMaxChars: 100000 } as never,
      mockRedis as never,
    );
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      { messageId: 'u1', role: 'user', content: '好的', timestamp: BASE + 1000 },
      { messageId: 'a1', role: 'assistant', content: '岗位卡片已投递', timestamp: BASE + 2000 },
      { messageId: 'u2', role: 'user', content: '下一批 pending', timestamp: BASE + 3000 },
    ]);

    const result = await customService.getMessages('chat_1', {
      endTimeInclusive: BASE + 1000,
    });

    // 边界与滚动窗口都不下推到 SQL（SQL 无法区分角色），DB 只按条数封顶
    expect(mockRepo.getChatHistory).toHaveBeenCalledWith('chat_1', 60);

    // 边界后的 assistant 保留（插到触发块之前），边界后的 user 裁掉
    expect(result.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect(result[0].content).toContain('岗位卡片已投递');
    expect(result[1].content).toContain('好的');
    expect(result.some((m) => m.content.includes('下一批 pending'))).toBe(false);

    // 缓存回填保留未裁剪的完整窗口
    expect(rebuildPayloads()).toHaveLength(3);
  });

  it('should keep post-cutoff assistant messages from cache, reinserted before the trailing user block', async () => {
    const customService = new MessageWindowService(
      mockRepo as never,
      { ...mockConfig, sessionWindowMaxChars: 100000 } as never,
      mockRedis as never,
    );
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'a1',
        role: 'assistant',
        content: '给你看最近的3家',
        timestamp: BASE,
        provenanceVersion: 2,
      }),
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'u1',
        role: 'user',
        content: '好的',
        timestamp: BASE + 1000,
        provenanceVersion: 2,
      }),
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'a2',
        role: 'assistant',
        content: '1. 必胜客岗位卡片',
        timestamp: BASE + 2000,
        provenanceVersion: 2,
      }),
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'u2',
        role: 'user',
        content: '下一批 pending',
        timestamp: BASE + 3000,
        provenanceVersion: 2,
      }),
    ]);

    const result = await customService.getMessages('chat_1', {
      endTimeInclusive: BASE + 1000,
    });

    expect(mockRepo.getChatHistory).not.toHaveBeenCalled();
    // 已投递的岗位卡片保留，且插在本轮触发消息「好的」之前，窗口仍以 user 收尾
    expect(result.map((m) => m.role)).toEqual(['assistant', 'assistant', 'user']);
    expect(result[1].content).toContain('必胜客岗位卡片');
    expect(result[2].content).toContain('好的');
    expect(result.some((m) => m.content.includes('下一批 pending'))).toBe(false);
  });

  it('should read the latest N rows from DB without a time predicate', async () => {
    // 滚动窗口锚在上一次开口而非当前时间，按 now 过滤会让回访者拿到空窗口，
    // 所以 DB 侧只留条数硬上限，窗口在内存里套。
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    await service.getMessages('chat_custom');

    expect(mockRepo.getChatHistory).toHaveBeenCalledTimes(1);
    expect(mockRepo.getChatHistory).toHaveBeenCalledWith('chat_custom', 60);
  });

  it('should preserve provenance from DB history through time injection and cache backfill', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      {
        messageId: 'manual-1',
        role: 'assistant',
        content: '上海嘉定同济园是吧',
        timestamp: BASE,
        source: StorageMessageSource.MOBILE_PUSH,
        messageType: StorageMessageType.TEXT,
        isSelf: true,
      },
    ]);

    const result = await service.getMessages('chat_1');

    expect(result[0]).toMatchObject({
      role: 'assistant',
      source: StorageMessageSource.MOBILE_PUSH,
      messageType: StorageMessageType.TEXT,
      isSelf: true,
    });
    const serialized = rebuildPayloads()[0];
    expect(JSON.parse(serialized)).toMatchObject({
      source: StorageMessageSource.MOBILE_PUSH,
      messageType: StorageMessageType.TEXT,
      isSelf: true,
      provenanceVersion: 2,
    });
  });

  it('should invalidate legacy cache entries and rebuild provenance from DB on the same key', async () => {
    mockRedis.lrange.mockResolvedValue([
      JSON.stringify({
        chatId: 'chat_1',
        messageId: 'legacy-1',
        role: 'assistant',
        content: '旧缓存无来源',
        timestamp: BASE,
      }),
    ]);
    mockRepo.getChatHistory.mockResolvedValue([
      {
        messageId: 'manual-1',
        role: 'assistant',
        content: 'DB 人工消息',
        timestamp: BASE,
        source: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
        messageType: StorageMessageType.TEXT,
        isSelf: true,
      },
    ]);

    const result = await service.getMessages('chat_1');

    expect(mockRedis.del).toHaveBeenCalledWith(buildChatHistoryCacheKey('chat_1'));
    expect(mockRepo.getChatHistory).toHaveBeenCalled();
    expect(result[0]).toMatchObject({
      source: StorageMessageSource.AGGREGATED_CHAT_MANUAL,
      isSelf: true,
    });
  });

  it('should rebuild the cache with a single atomic script carrying limits and ttl', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([
      { messageId: 'u1', role: 'user', content: '你好', timestamp: Date.now() - 1000 },
    ]);

    await service.getMessages('chat_1');

    // 不再是 del → rpush → expire → ltrim 四次往返，避免并发追加插进 DEL 与 RPUSH 之间
    expect(mockRedis.rpush).not.toHaveBeenCalled();
    expect(mockRedis.ltrim).not.toHaveBeenCalled();
    expect(mockRedis.expire).not.toHaveBeenCalled();
    expect(mockRedis.eval).toHaveBeenCalledTimes(1);
    const [, keys, args] = mockRedis.eval.mock.calls[0] as [string, string[], (string | number)[]];
    expect(keys).toEqual([buildChatHistoryCacheKey('chat_1')]);
    expect(args.slice(0, 2)).toEqual([60, 86400]);
    expect(args).toHaveLength(3);
  });

  it('should not create the cache key when DB history is empty', async () => {
    mockRedis.lrange.mockResolvedValue([]);
    mockRepo.getChatHistory.mockResolvedValue([]);

    const result = await service.getMessages('chat_empty');

    expect(result).toEqual([]);
    expect(mockRedis.eval).not.toHaveBeenCalled();
  });

  describe('rolling history window (anchor = last user message before this batch)', () => {
    const DAY = 86400 * 1000;
    const entry = (
      messageId: string,
      role: 'user' | 'assistant',
      content: string,
      timestamp: number,
    ) => ({ chatId: 'chat_1', messageId, role, content, timestamp, provenanceVersion: 2 });
    const wide = () =>
      new MessageWindowService(
        mockRepo as never,
        { ...mockConfig, sessionWindowMaxChars: 100000 } as never,
        mockRedis as never,
      );

    it('recovers the last 7 days of the previous episode for a candidate returning after a gap', async () => {
      const now = Date.now();
      const anchor = now - 20 * DAY; // 上一段咨询里候选人最后一次开口
      mockRedis.lrange.mockResolvedValue([
        JSON.stringify(entry('too-old', 'user', '一个月前', anchor - 8 * DAY)),
        JSON.stringify(entry('u-old', 'user', '上一段开头', anchor - 2 * DAY)),
        JSON.stringify(entry('a-old', 'assistant', '上一段回复', anchor - DAY)),
        JSON.stringify(entry('u-anchor', 'user', '上一段最后一句', anchor)),
        JSON.stringify(entry('a-tail', 'assistant', '上一段收尾', anchor + 60_000)),
        JSON.stringify(entry('u-now', 'user', '还在招吗', now)),
      ]);

      const result = await wide().getMessages('chat_1');

      expect(mockRepo.getChatHistory).not.toHaveBeenCalled();
      expect(result.map((m) => m.content.split('\n')[0])).toEqual([
        '上一段开头',
        '上一段回复',
        '上一段最后一句',
        '上一段收尾',
        '还在招吗',
      ]);
    });

    it('keeps reengagement touches sent during the silence: the anchor is the last user message, not the last message', async () => {
      const now = Date.now();
      mockRedis.lrange.mockResolvedValue([
        JSON.stringify(entry('u-old', 'user', '半月前咨询', now - 15 * DAY)),
        JSON.stringify(entry('a-old', 'assistant', '半月前回复', now - 15 * DAY + 60_000)),
        JSON.stringify(entry('touch', 'assistant', '复聊触达', now - 2 * DAY)),
        JSON.stringify(entry('u-now', 'user', '在的', now)),
      ]);

      const result = await wide().getMessages('chat_1');

      // 若锚在最后一条消息（触达，2 天前），半月前的咨询会被顶掉
      expect(result).toHaveLength(4);
      expect(result[0].content).toContain('半月前咨询');
    });

    it('does not trim a first consultation (no earlier user message)', async () => {
      const now = Date.now();
      mockRedis.lrange.mockResolvedValue([
        JSON.stringify(entry('greet', 'assistant', '你好呀', now - 30 * DAY)),
        JSON.stringify(entry('u1', 'user', '我想找工作', now - 1000)),
        JSON.stringify(entry('u2', 'user', '有岗位吗', now)),
      ]);

      const result = await wide().getMessages('chat_1');

      expect(result).toHaveLength(3);
    });

    it('applies the same window on the DB fallback path', async () => {
      const now = Date.now();
      const anchor = now - 20 * DAY;
      mockRedis.lrange.mockResolvedValue([]);
      mockRepo.getChatHistory.mockResolvedValue([
        { messageId: 'too-old', role: 'user', content: '一个月前', timestamp: anchor - 8 * DAY },
        {
          messageId: 'a-old',
          role: 'assistant',
          content: '一个月前回复',
          timestamp: anchor - 8 * DAY + 60_000,
        },
        { messageId: 'u-anchor', role: 'user', content: '上一段最后一句', timestamp: anchor },
        {
          messageId: 'a-tail',
          role: 'assistant',
          content: '上一段收尾',
          timestamp: anchor + 60_000,
        },
        { messageId: 'u-now', role: 'user', content: '还在招吗', timestamp: now },
      ]);

      const result = await wide().getMessages('chat_1');

      expect(result.map((m) => m.content.split('\n')[0])).toEqual([
        '上一段最后一句',
        '上一段收尾',
        '还在招吗',
      ]);
      // 回填仍存完整快照，窗口只是读取视图
      expect(rebuildPayloads()).toHaveLength(5);
    });
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
