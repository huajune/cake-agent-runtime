export interface CachedChatHistoryMessage {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface CachedChatHistoryMessageIndex {
  chatId: string;
}

const CHAT_HISTORY_CACHE_PREFIX = 'memory:short_term:chat';
const CHAT_HISTORY_INDEX_PREFIX = 'memory:short_term:message';

export function buildChatHistoryCacheKey(chatId: string): string {
  return `${CHAT_HISTORY_CACHE_PREFIX}:${chatId}`;
}

export function buildChatHistoryIndexKey(messageId: string): string {
  return `${CHAT_HISTORY_INDEX_PREFIX}:${messageId}`;
}

export function serializeCachedChatHistoryMessage(message: CachedChatHistoryMessage): string {
  return JSON.stringify(message);
}

export function parseCachedChatHistoryMessages(rawMessages: string[]): CachedChatHistoryMessage[] {
  return rawMessages
    .map((raw) => {
      try {
        return JSON.parse(raw) as Partial<CachedChatHistoryMessage>;
      } catch {
        return null;
      }
    })
    .filter((message): message is CachedChatHistoryMessage => {
      return Boolean(
        message &&
          typeof message.chatId === 'string' &&
          typeof message.messageId === 'string' &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string' &&
          typeof message.timestamp === 'number',
      );
    });
}
