import {
  buildChatHistoryCacheKey,
  parseCachedChatHistoryMessages,
  serializeCachedChatHistoryMessage,
} from '@biz/message/utils/chat-history-cache.util';
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
});
