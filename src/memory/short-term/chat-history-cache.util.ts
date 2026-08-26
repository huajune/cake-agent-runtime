import type { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

export interface CachedChatHistoryMessage {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** 消息来源元数据；用于区分真人招募经理与 Agent/自动消息。 */
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  /** 仅保留 payload.source，避免把完整回调 payload 放大到短期缓存。 */
  payloadSource?: string;
  /** v2 表示该条已走 provenance-aware writer/backfill；兼容滚动发布时的旧缓存。 */
  provenanceVersion?: 2;
}

const CHAT_HISTORY_CACHE_PREFIX = 'memory:short_term:chat';

export function buildChatHistoryCacheKey(chatId: string): string {
  return `${CHAT_HISTORY_CACHE_PREFIX}:${chatId}`;
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
