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

/** 短期记忆层 — 当前会话窗口 */
export interface ShortTermMemoryState {
  messages: ShortTermMessage[];
}
