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
  WITH base AS (
    SELECT *
    FROM message_processing_records m
    WHERE m.received_at >= p_hour_start
      AND m.received_at < p_hour_end
  ),
  invocation_base AS (
    SELECT *
    FROM base b
    WHERE COALESCE(b.is_primary, b.batch_id IS NULL)
  ),
  duration_stats AS (
    SELECT
      COALESCE(percentile_cont(0.50) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p50,
      COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p95,
      COALESCE(percentile_cont(0.99) WITHIN GROUP (ORDER BY b.total_duration), 0) AS p99
    FROM base b
    WHERE b.status = 'success'
      AND b.total_duration IS NOT NULL
      AND b.total_duration > 0
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
        COALESCE(b.scenario, 'unknown') AS scenario_name,
        COUNT(*)::int AS cnt,
        COUNT(*) FILTER (WHERE b.status = 'success')::int AS succ,
        ROUND(COALESCE(AVG(b.total_duration) FILTER (WHERE b.total_duration > 0), 0))::int AS avg_dur
      FROM base b
      GROUP BY COALESCE(b.scenario, 'unknown')
    ) sub
  ),
  tool_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(sub.tool_name, sub.tool_count),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        unnest(b.tools) AS tool_name,
        COUNT(*)::int AS tool_count
      FROM invocation_base b
      WHERE b.tools IS NOT NULL
        AND array_length(b.tools, 1) > 0
      GROUP BY unnest(b.tools)
    ) sub
  )
  SELECT
    (SELECT COUNT(*) FROM base)::bigint AS message_count,
    (SELECT COUNT(*) FROM base b WHERE b.status = 'success')::bigint AS success_count,
    (SELECT COUNT(*) FROM base b WHERE b.status != 'success')::bigint AS failure_count,
    ROUND(
      CASE WHEN (SELECT COUNT(*) FROM base) > 0
        THEN (
          (SELECT COUNT(*) FROM base b WHERE b.status = 'success')::numeric /
          (SELECT COUNT(*) FROM base)::numeric
        ) * 100
        ELSE 0
      END,
      2
    )::numeric AS success_rate,
    (
      SELECT ROUND(COALESCE(AVG(b.total_duration) FILTER (
        WHERE b.status = 'success' AND b.total_duration > 0
      ), 0))::numeric
      FROM base b
    ) AS avg_duration,
    (
      SELECT ROUND(COALESCE(MIN(b.total_duration) FILTER (
        WHERE b.status = 'success' AND b.total_duration > 0
      ), 0))::numeric
      FROM base b
    ) AS min_duration,
    (
      SELECT ROUND(COALESCE(MAX(b.total_duration) FILTER (
        WHERE b.status = 'success' AND b.total_duration > 0
      ), 0))::numeric
      FROM base b
    ) AS max_duration,
    ROUND(ds.p50::numeric) AS p50_duration,
    ROUND(ds.p95::numeric) AS p95_duration,
    ROUND(ds.p99::numeric) AS p99_duration,
    (
      SELECT ROUND(COALESCE(AVG(ib.ai_duration) FILTER (
        WHERE ib.status = 'success' AND ib.ai_duration > 0
      ), 0))::numeric
      FROM invocation_base ib
    ) AS avg_ai_duration,
    (
      SELECT ROUND(COALESCE(AVG(ib.send_duration) FILTER (
        WHERE ib.status = 'success' AND ib.send_duration > 0
      ), 0))::numeric
      FROM invocation_base ib
    ) AS avg_send_duration,
    (SELECT COUNT(DISTINCT b.user_id) FROM base b)::bigint AS active_users,
    (SELECT COUNT(DISTINCT b.chat_id) FROM base b)::bigint AS active_chats,
    (
      SELECT COALESCE(SUM(ib.token_usage) FILTER (WHERE ib.token_usage IS NOT NULL), 0)::bigint
      FROM invocation_base ib
    ) AS total_token_usage,
    (SELECT COUNT(*) FROM invocation_base ib WHERE ib.is_fallback = true)::bigint AS fallback_count,
    (
      SELECT COUNT(*)
      FROM invocation_base ib
      WHERE ib.is_fallback = true
        AND ib.fallback_success = true
    )::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta;
END;
$$;
