import type { AgentStepDetail, AgentToolCall } from '@shared-types/agent-telemetry.types';

type InvocationProjection = { request: unknown; response: unknown };

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
  source_occurred_at?: string;
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
  ai_duration?: number;
  ttft_ms?: number | string;
  send_duration?: number;
  token_usage?: number;
  is_fallback?: boolean;
  fallback_success?: boolean;
  message_processing_turn_snapshots?: InvocationProjection | null;
  batch_id?: string;
  /** 工具调用详情 JSONB */
  tool_calls?: Array<AgentToolCall & { stepPosition?: number }> | null;
  /** 每步循环快照 JSONB */
  agent_steps?: Array<Omit<AgentStepDetail, 'toolCalls'>> | null;
  /** 异常信号数组 */
  anomaly_flags?: string[];
  /** 入站守卫拦截摘要 JSONB（仅拦截命中时非空） */
  guardrail_input?: unknown;
  /** 出站守卫审查过程的摘要 */
  guardrail_output?: unknown;
  /** 记忆上下文快照 JSONB */
  memory_snapshot?: unknown;
  /** turn-end 后处理状态 JSONB */
  post_processing_status?: unknown;
}
