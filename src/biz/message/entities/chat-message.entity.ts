import {
  StorageMessageType,
  StorageMessageSource,
  StorageContactType,
} from '@enums/storage-message.enum';

/**
 * 聊天消息记录（Supabase 存储格式）
 * @table chat_messages
 */
export interface ChatMessageRecord {
  chat_id: string;
  message_id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  candidate_name?: string;
  manager_name?: string;
  org_id?: string;
  bot_id?: string;
  message_type?: StorageMessageType;
  source?: StorageMessageSource;
  is_room?: boolean;
  im_bot_id?: string;
  im_contact_id?: string;
  contact_type?: StorageContactType;
  is_self?: boolean;
  payload?: Record<string, unknown>;
  avatar?: string;
  external_user_id?: string;
}
