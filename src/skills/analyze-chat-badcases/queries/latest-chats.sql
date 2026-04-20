-- 最近 N 个候选人完整对话 + 每 turn 工具调用/记忆/异常信号
-- 使用方式：通过 mcp__supabase__execute_sql（project_id=uvmbxcilpteaiizplcyp）运行
-- 参数：:sample_size — 抽样的候选人数量（默认 15）
-- 注意：刻意不 SELECT mpr.agent_invocation，其 90% 是重复的 system prompt / tools schema

WITH latest_chats AS (
  SELECT chat_id, MAX(timestamp) AS last_at
  FROM chat_messages
  GROUP BY chat_id
  ORDER BY last_at DESC
  LIMIT :sample_size
)
SELECT
  cm.chat_id,
  cm.message_id,
  cm.role,
  cm.content,
  cm.timestamp,
  cm.candidate_name,
  cm.manager_name,
  mpr.status,
  mpr.error,
  mpr.is_fallback,
  mpr.fallback_success,
  mpr.anomaly_flags,
  mpr.tool_calls,
  mpr.memory_snapshot,
  mpr.ai_duration,
  mpr.total_duration
FROM chat_messages cm
INNER JOIN latest_chats lc ON cm.chat_id = lc.chat_id
LEFT JOIN message_processing_records mpr ON cm.message_id = mpr.message_id
ORDER BY cm.chat_id, cm.timestamp;
