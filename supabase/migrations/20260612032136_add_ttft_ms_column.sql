-- ============================================================
-- Migration: ttft_ms 落为真实列，消除查询期 agent_invocation detoast
-- 2026-06-12
--
-- 背景：消息处理页（/web/message-processing）列表与统计均通过
-- agent_invocation->response->timings->durations->>requestToFirstTextDeltaMs
-- 现场提取 TTFT。agent_invocation 平均 43KB/行（TOAST 总量 ~700MB），
-- 该 JSON 路径提取迫使每行解压：
--   - 列表 50 行实测 1279ms（去掉该列仅 0.9ms）
--   - get_dashboard_overview_stats 30 天范围实测 52.6s
--
-- 方案：新增真实列 ttft_ms，写入侧落库时抽取；RPC 改读新列。
-- 存量回填不在本迁移内执行（避免单事务长时间持有全表行锁），
-- 由运维侧分批执行：
--   UPDATE message_processing_records
--   SET ttft_ms = NULLIF(agent_invocation->'response'->'timings'->'durations'->>'requestToFirstTextDeltaMs', '')::numeric::integer
--   WHERE ttft_ms IS NULL AND agent_invocation IS NOT NULL
--     AND received_at >= :batch_start AND received_at < :batch_end;
-- ============================================================

ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS ttft_ms integer;

COMMENT ON COLUMN message_processing_records.ttft_ms IS
  '请求到首个文本增量的耗时(ms)，写入侧从 agent_invocation 抽取落库，查询不再解压 JSONB';

-- 重建概览 RPC：avg_ttft 改读 ttft_ms 列（签名/返回类型不变）
CREATE OR REPLACE FUNCTION get_dashboard_overview_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  total_messages bigint,
  success_count bigint,
  failure_count bigint,
  success_rate numeric,
  avg_duration numeric,
  active_users bigint,
  active_chats bigint,
  total_token_usage bigint,
  avg_ttft numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint AS total_messages,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE m.status != 'success')::bigint AS failure_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE m.status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END,
      2
    ) AS success_rate,
    ROUND(
      COALESCE(
        AVG(m.total_duration) FILTER (
          WHERE m.total_duration IS NOT NULL
            AND m.total_duration > 0
        ),
        0
      ),
      0
    ) AS avg_duration,
    COUNT(DISTINCT m.user_id)::bigint AS active_users,
    COUNT(DISTINCT m.chat_id)::bigint AS active_chats,
    COALESCE(
      SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL),
      0
    )::bigint AS total_token_usage,
    ROUND(
      COALESCE(
        AVG(m.ttft_ms) FILTER (WHERE m.ttft_ms IS NOT NULL AND m.ttft_ms > 0),
        0
      ),
      0
    ) AS avg_ttft
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$$;
