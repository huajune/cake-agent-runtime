import type { StorageMessageSource, StorageMessageType } from '@enums/storage-message.enum';
import type { PostProcessingStatus } from '@shared-types/tracking.types';

export const MEMORY_CHAT_SESSION_PORT = Symbol('MEMORY_CHAT_SESSION_PORT');
export const MEMORY_SYSTEM_CONFIG_PORT = Symbol('MEMORY_SYSTEM_CONFIG_PORT');
export const MEMORY_MESSAGE_PROCESSING_PORT = Symbol('MEMORY_MESSAGE_PROCESSING_PORT');

export interface MemoryChatHistoryMessage {
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  source?: StorageMessageSource;
  messageType?: StorageMessageType;
  isSelf?: boolean;
  payloadSource?: string;
}

/** memory 读取聊天历史所需的最窄业务端口。 */
export interface MemoryChatSessionPort {
  getChatHistory(
    chatId: string,
    limit: number,
    options?: { startTimeInclusive?: number; endTimeInclusive?: number },
  ): Promise<MemoryChatHistoryMessage[]>;
  getChatHistoryInRange(
    chatId: string,
    options: { startTimeExclusive?: number; endTimeInclusive?: number; limit?: number },
  ): Promise<Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>>;
}

/** memory 的提取/摘要只读取这一项模型覆盖。 */
export interface MemorySystemConfigPort {
  getExtractModelOverride(): Promise<string | undefined>;
}

/** turn-end 只回写后处理状态，不依赖业务查询面。 */
export interface MemoryMessageProcessingPort {
  updatePostProcessingStatus(messageId: string, status: PostProcessingStatus): Promise<boolean>;
}
