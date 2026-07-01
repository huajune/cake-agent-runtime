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
  /** 托管账号系统 wxid（= bot_im_id），与 user_activity/chat_messages 同一形态 */
  bot_im_id?: string;
  received_at: string;
  message_preview?: string;
  reply_preview?: string;
  reply_segments?: number;
  status: string;
  error?: string;
  alert_type?: string;
  scenario?: string;
  total_duration?: number;
  queue_duration?: number;
  prep_duration?: number;
  ai_start_at?: number;
  ai_end_at?: number;
  ai_duration?: number;
  ttft_ms?: number | string;
  send_duration?: number;
  token_usage?: number;
  is_fallback?: boolean;
  fallback_success?: boolean;
  agent_invocation?: unknown;
  batch_id?: string;
  /** 工具调用详情 JSONB */
  tool_calls?: unknown;
  /** 每步循环快照 JSONB */
  agent_steps?: unknown;
  /** 异常信号数组 */
  anomaly_flags?: string[];
  /** 记忆上下文快照 JSONB */
  memory_snapshot?: unknown;
  /** turn-end 后处理状态 JSONB */
  post_processing_status?: unknown;
  /** 入站守卫裁决摘要 JSONB（仅 block 时非空） */
  guardrail_input?: unknown;
  /** 出站守卫裁决摘要 JSONB（pass/revise/block 全量） */
  guardrail_output?: unknown;
}
