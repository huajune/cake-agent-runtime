-- ============================================================
-- Migration: expose avg_ttft in dashboard overview RPC
-- 2026-04-16
--
-- 消息处理页顶部主指标已切换为 TTFT，需要在概览 RPC 中直接返回
-- 聚合后的平均 TTFT，避免前端继续错误复用 avg_duration(E2E)。
-- ============================================================

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
        AVG(
          NULLIF(
            m.agent_invocation->'response'->'timings'->'durations'->>'requestToFirstTextDeltaMs',
            ''
          )::numeric
        ) FILTER (
          WHERE NULLIF(
            m.agent_invocation->'response'->'timings'->'durations'->>'requestToFirstTextDeltaMs',
            ''
          ) IS NOT NULL
            AND NULLIF(
              m.agent_invocation->'response'->'timings'->'durations'->>'requestToFirstTextDeltaMs',
              ''
            )::numeric > 0
        ),
        0
      ),
      0
    ) AS avg_ttft
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$$;
