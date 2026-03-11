import { StorageMessageType, StorageMessageSource, StorageContactType } from '@wecom/message/enums';

/**
 * 聊天消息记录（Supabase 存储格式）
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

/**
 * 聊天消息输入格式
 */
export interface ChatMessageInput {
  chatId: string;
  messageId: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  candidateName?: string;
  managerName?: string;
  orgId?: string;
  botId?: string;
  messageType?: number;
  source?: number;
  isRoom?: boolean;
  imBotId?: string;
  imContactId?: string;
  contactType?: number;
  isSelf?: boolean;
  payload?: Record<string, unknown>;
  avatar?: string;
  externalUserId?: string;
}

/**
 * 会话列表查询的原始行
 */
export interface SessionRawRow {
  chat_id: string;
  candidate_name?: string;
  manager_name?: string;
  content: string;
  timestamp: string;
  avatar?: string;
  contact_type?: string;
  role: string;
}

/**
 * 会话摘要（分组后的结果）
 */
export interface ChatSessionSummary {
  chatId: string;
  candidateName?: string;
  managerName?: string;
  messageCount: number;
  lastMessage?: string;
  lastTimestamp?: number;
  avatar?: string;
  contactType?: string;
}

/**
 * 预约记录输入
 */
export interface BookingRecordInput {
  brandName?: string;
  storeName?: string;
  chatId?: string;
  userId?: string;
  userName?: string;
  managerId?: string;
  managerName?: string;
}

/**
 * 预约统计数据
 */
export interface BookingStats {
  date: string;
  brandName: string | null;
  storeName: string | null;
  bookingCount: number;
  chatId: string | null;
  userId: string | null;
  userName: string | null;
  managerId: string | null;
  managerName: string | null;
}

/**
 * 预约记录数据库格式
 */
export interface BookingDbRecord {
  date: string;
  brand_name: string | null;
  store_name: string | null;
  booking_count: number;
  chat_id: string | null;
  user_id: string | null;
  user_name: string | null;
  manager_id: string | null;
  manager_name: string | null;
}

/**
 * 消息处理记录输入
 */
export interface MessageProcessingRecordInput {
  messageId: string;
  chatId: string;
  userId?: string;
  userName?: string;
  managerName?: string;
  receivedAt: number;
  messagePreview?: string;
  replyPreview?: string;
  replySegments?: number;
  status: 'processing' | 'success' | 'failure';
  error?: string;
  scenario?: string;
  totalDuration?: number;
  queueDuration?: number;
  prepDuration?: number;
  aiStartAt?: number;
  aiEndAt?: number;
  aiDuration?: number;
  sendDuration?: number;
  tools?: string[];
  tokenUsage?: number;
  isFallback?: boolean;
  fallbackSuccess?: boolean;
  agentInvocation?: unknown;
  batchId?: string;
  isPrimary?: boolean;
}

/**
 * 消息处理记录数据库格式
 */
export interface MessageProcessingDbRecord {
  message_id: string;
  chat_id: string;
  user_id?: string;
  user_name?: string;
  manager_name?: string;
  received_at: string;
  message_preview?: string;
  reply_preview?: string;
  reply_segments?: number;
  status: string;
  error?: string;
  scenario?: string;
  total_duration?: number;
  queue_duration?: number;
  prep_duration?: number;
  ai_start_at?: number;
  ai_end_at?: number;
  ai_duration?: number;
  send_duration?: number;
  tools?: string[];
  token_usage?: number;
  is_fallback?: boolean;
  fallback_success?: boolean;
  agent_invocation?: unknown;
  batch_id?: string;
  is_primary?: boolean;
}
