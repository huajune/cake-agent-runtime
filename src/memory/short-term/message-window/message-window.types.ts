import type { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';

/** 短期记忆中的单条消息 */
export interface ShortTermMessage {
  role: string;
  content: string;
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  payloadSource?: string;
}

/** message-window 层 — 当前消息窗口 */
export interface ShortTermMemoryState {
  messages: ShortTermMessage[];
}
