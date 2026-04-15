CREATE OR REPLACE FUNCTION aggregate_hourly_stats(
  p_hour_start timestamp with time zone,
  p_hour_end timestamp with time zone
)
RETURNS TABLE(
  message_count bigint,
  success_count bigint,
  failure_count bigint,
  success_rate numeric,
  avg_duration numeric,
  min_duration numeric,
  max_duration numeric,
  p50_duration numeric,
  p95_duration numeric,
  p99_duration numeric,
  avg_ai_duration numeric,
  avg_send_duration numeric,
  active_users bigint,
  active_chats bigint,
  total_token_usage bigint,
  fallback_count bigint,
  fallback_success_count bigint,
  scenario_stats jsonb,
  tool_stats jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH request_base AS (
    SELECT *
    FROM message_processing_records m
    WHERE m.received_at >= p_hour_start
      AND m.received_at < p_hour_end
  ),
  duration_stats AS (
    SELECT
      COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY total_duration), 0) AS p50,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY total_duration), 0) AS p95,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY total_duration), 0) AS p99
    FROM request_base
    WHERE status = 'success'
      AND total_duration IS NOT NULL
      AND total_duration > 0
  ),
  scenario_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(
        sub.scenario_name,
        jsonb_build_object(
          'count', sub.cnt,
          'successCount', sub.succ,
          'avgDuration', sub.avg_dur
        )
      ),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        COALESCE(scenario, 'unknown') AS scenario_name,
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE status = 'success')::int AS succ,
        ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration > 0), 0))::int AS avg_dur
      FROM request_base
      GROUP BY COALESCE(scenario, 'unknown')
    ) sub
  ),
  tool_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(sub.tool_name, sub.tool_count),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        unnest(tools) AS tool_name,
        COUNT(*)::int AS tool_count
      FROM request_base
      WHERE tools IS NOT NULL
        AND array_length(tools, 1) > 0
      GROUP BY unnest(tools)
    ) sub
  )
  SELECT
    (SELECT COUNT(*) FROM request_base)::bigint AS message_count,
    (SELECT COUNT(*) FROM request_base WHERE status = 'success')::bigint AS success_count,
    (SELECT COUNT(*) FROM request_base WHERE status != 'success')::bigint AS failure_count,
    ROUND(
      CASE
        WHEN (SELECT COUNT(*) FROM request_base) > 0
        THEN (
          (SELECT COUNT(*) FROM request_base WHERE status = 'success')::numeric
          /
          (SELECT COUNT(*) FROM request_base)::numeric
        ) * 100
        ELSE 0
      END,
      2
    )::numeric AS success_rate,
    (
      SELECT ROUND(COALESCE(AVG(total_duration) FILTER (
        WHERE status = 'success' AND total_duration > 0
      ), 0))::numeric
      FROM request_base
    ) AS avg_duration,
    (
      SELECT ROUND(COALESCE(MIN(total_duration) FILTER (
        WHERE status = 'success' AND total_duration > 0
      ), 0))::numeric
      FROM request_base
    ) AS min_duration,
    (
      SELECT ROUND(COALESCE(MAX(total_duration) FILTER (
        WHERE status = 'success' AND total_duration > 0
      ), 0))::numeric
      FROM request_base
    ) AS max_duration,
    ROUND(ds.p50::numeric) AS p50_duration,
    ROUND(ds.p95::numeric) AS p95_duration,
    ROUND(ds.p99::numeric) AS p99_duration,
    (
      SELECT ROUND(COALESCE(AVG(ai_duration) FILTER (
        WHERE status = 'success' AND ai_duration > 0
      ), 0))::numeric
      FROM request_base
    ) AS avg_ai_duration,
    (
      SELECT ROUND(COALESCE(AVG(send_duration) FILTER (
        WHERE status = 'success' AND send_duration > 0
      ), 0))::numeric
      FROM request_base
    ) AS avg_send_duration,
    (SELECT COUNT(DISTINCT user_id) FROM request_base)::bigint AS active_users,
    (SELECT COUNT(DISTINCT chat_id) FROM request_base)::bigint AS active_chats,
    (
      SELECT COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint
      FROM request_base
    ) AS total_token_usage,
    (SELECT COUNT(*) FROM request_base WHERE is_fallback = true)::bigint AS fallback_count,
    (
      SELECT COUNT(*)
      FROM request_base
      WHERE is_fallback = true
        AND fallback_success = true
    )::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta;
END;
$$;
