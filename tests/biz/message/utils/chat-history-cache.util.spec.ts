import {
  buildChatHistoryCacheKey,
  parseCachedChatHistoryMessages,
  serializeCachedChatHistoryMessage,
} from '@biz/message/utils/chat-history-cache.util';

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
    });

    expect(parseCachedChatHistoryMessages([raw])).toEqual([
      {
        chatId: 'chat-1',
        messageId: 'msg-1',
        role: 'user',
        content: '你好',
        timestamp: 123,
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
});
