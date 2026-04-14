/**
 * 消息处理记录数据库格式
 * @table message_processing_records
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
  ttft_ms?: number | string;
  send_duration?: number;
  tools?: string[];
  token_usage?: number;
  is_fallback?: boolean;
  fallback_success?: boolean;
  agent_invocation?: unknown;
  batch_id?: string;
}
