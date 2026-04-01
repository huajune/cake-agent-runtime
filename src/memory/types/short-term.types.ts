import type { ChatMessageRecord } from '@biz/message/entities/chat-message.entity';

/** 短期记忆中的单条消息 */
export interface ShortTermMessage {
  role: string;
  content: string;
}

/** 短期记忆层 — 当前会话窗口 */
export interface ShortTermMemoryState {
  messages: ShortTermMessage[];
}

/** chat_messages 中原始存储的单条消息结构。 */
export type ShortTermStorageRecord = ChatMessageRecord;

/** 短期消息窗口层的真实持久化结果。 */
export interface ShortTermStorageResult {
  source: 'chat_messages';
  table: 'chat_messages';
  records: ShortTermStorageRecord[];
}
