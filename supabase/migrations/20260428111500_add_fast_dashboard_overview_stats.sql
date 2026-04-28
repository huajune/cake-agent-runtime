-- Dashboard 概览专用轻量 RPC。
-- get_dashboard_overview_stats 需要额外计算 avg_ttft，会扫描 agent_invocation JSONB；
-- 仪表盘概览不展示 TTFT，因此单独提供不读大 JSON 字段的版本。

CREATE OR REPLACE FUNCTION get_dashboard_overview_stats_fast(
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
  total_token_usage bigint
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
    )::bigint AS total_token_usage
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$$;
