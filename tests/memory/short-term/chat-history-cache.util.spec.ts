import {
  appendChatHistoryCacheEntry,
  buildChatHistoryCacheKey,
  parseCachedChatHistoryMessages,
  rebuildChatHistoryCache,
  serializeCachedChatHistoryMessage,
} from '@memory/short-term/chat-history-cache.util';
import { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

describe('chat-history-cache.util', () => {
  it('should build cache key', () => {
    expect(buildChatHistoryCacheKey('chat-1')).toBe('memory:short_term:chat:chat-1');
  });

  it('should serialize and parse cached messages', () => {
    const raw = serializeCachedChatHistoryMessage({
      chatId: 'chat-1',
      messageId: 'msg-1',
      role: 'user',
      content: '你好',
      timestamp: 123,
      source: StorageMessageSource.MOBILE_PUSH,
      messageType: StorageMessageType.TEXT,
      isSelf: true,
      payloadSource: 'manual',
      provenanceVersion: 2,
    });

    expect(parseCachedChatHistoryMessages([raw])).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'msg-1',
        role: 'user',
        content: '你好',
        timestamp: 123,
        source: StorageMessageSource.MOBILE_PUSH,
        messageType: StorageMessageType.TEXT,
        isSelf: true,
        payloadSource: 'manual',
        provenanceVersion: 2,
      },
    ]);
  });

  it('should drop malformed cached messages', () => {
    expect(
      parseCachedChatHistoryMessages([
        '{"chatId":"chat-1","messageId":"msg-1","role":"user","content":"ok","timestamp":123}',
        '{"chatId":"chat-1"}',
        'not-json',
      ]),
    ).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'msg-1',
        role: 'user',
        content: 'ok',
        timestamp: 123,
      },
    ]);
  });

  describe('atomic scripts', () => {
    const limits = { maxMessages: 120, ttlSeconds: 259200 };

    it('append reports false when the list does not exist (RPUSHX returned 0)', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(0) };

      const appended = await appendChatHistoryCacheEntry(redis, 'chat-1', '{"x":1}', limits);

      expect(appended).toBe(false);
      const [script, keys, args] = redis.eval.mock.calls[0] as [
        string,
        string[],
        (string | number)[],
      ];
      expect(script).toContain('RPUSHX');
      expect(script).not.toMatch(/"RPUSH"/);
      expect(keys).toEqual(['memory:short_term:chat:chat-1']);
      expect(args).toEqual([120, 259200, '{"x":1}']);
    });

    it('append reports true when the list existed and the entry was pushed', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(7) };

      await expect(appendChatHistoryCacheEntry(redis, 'chat-1', '{}', limits)).resolves.toBe(true);
    });

    it('rebuild sends limits followed by every payload in one script call', async () => {
      const redis = { eval: jest.fn().mockResolvedValue(2) };

      await rebuildChatHistoryCache(redis, 'chat-1', ['{"a":1}', '{"b":2}'], limits);

      expect(redis.eval).toHaveBeenCalledTimes(1);
      const [script, keys, args] = redis.eval.mock.calls[0] as [
        string,
        string[],
        (string | number)[],
      ];
      expect(script).toContain('DEL');
      expect(script).toContain('RPUSH');
      expect(keys).toEqual(['memory:short_term:chat:chat-1']);
      expect(args).toEqual([120, 259200, '{"a":1}', '{"b":2}']);
    });

    it('rebuild is a no-op for an empty snapshot so the key is never created empty', async () => {
      const redis = { eval: jest.fn() };

      await rebuildChatHistoryCache(redis, 'chat-1', [], limits);

      expect(redis.eval).not.toHaveBeenCalled();
    });
  });
});
