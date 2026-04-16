COMMENT ON COLUMN monitoring_hourly_stats.failure_count IS '该小时 failure 请求数（不含 timeout）';
COMMENT ON COLUMN monitoring_daily_stats.failure_count IS '该日 failure 请求数（不含 timeout）';

CREATE OR REPLACE FUNCTION aggregate_hourly_stats(
  p_hour_start timestamp with time zone,
  p_hour_end timestamp with time zone
)
RETURNS TABLE(
  message_count bigint,
  success_count bigint,
  failure_count bigint,
  timeout_count bigint,
  success_rate numeric,
  avg_duration numeric,
  min_duration numeric,
  max_duration numeric,
  p50_duration numeric,
  p95_duration numeric,
  p99_duration numeric,
  avg_queue_duration numeric,
  avg_prep_duration numeric,
  avg_ai_duration numeric,
  avg_send_duration numeric,
  active_users bigint,
  active_chats bigint,
  total_token_usage bigint,
  fallback_count bigint,
  fallback_success_count bigint,
  error_type_stats jsonb,
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
  error_type_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(sub.error_type, sub.error_count),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        error_type,
        COUNT(*)::int AS error_count
      FROM (
        SELECT COALESCE(alert_type, 'unknown') AS error_type
        FROM request_base
        WHERE status = 'failure'

        UNION ALL

        SELECT 'timeout'::text AS error_type
        FROM request_base
        WHERE status = 'timeout'
      ) error_rows
      GROUP BY error_type
    ) sub
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
        tool_name,
        COUNT(*)::int AS tool_count
      FROM request_base,
           unnest(tools) AS tool_name
      WHERE tools IS NOT NULL
        AND array_length(tools, 1) > 0
      GROUP BY tool_name
    ) sub
  )
  SELECT
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE status = 'failure')::bigint AS failure_count,
    COUNT(*) FILTER (WHERE status = 'timeout')::bigint AS timeout_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END,
      2
    )::numeric AS success_rate,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE status = 'success' AND total_duration > 0), 0))::numeric AS avg_duration,
    ROUND(COALESCE(MIN(total_duration) FILTER (WHERE status = 'success' AND total_duration > 0), 0))::numeric AS min_duration,
    ROUND(COALESCE(MAX(total_duration) FILTER (WHERE status = 'success' AND total_duration > 0), 0))::numeric AS max_duration,
    ROUND(ds.p50::numeric) AS p50_duration,
    ROUND(ds.p95::numeric) AS p95_duration,
    ROUND(ds.p99::numeric) AS p99_duration,
    ROUND(COALESCE(AVG(queue_duration) FILTER (WHERE queue_duration > 0), 0))::numeric AS avg_queue_duration,
    ROUND(COALESCE(AVG(prep_duration) FILTER (WHERE prep_duration > 0), 0))::numeric AS avg_prep_duration,
    ROUND(COALESCE(AVG(ai_duration) FILTER (WHERE status = 'success' AND ai_duration > 0), 0))::numeric AS avg_ai_duration,
    ROUND(COALESCE(AVG(send_duration) FILTER (WHERE status = 'success' AND send_duration > 0), 0))::numeric AS avg_send_duration,
    COUNT(DISTINCT user_id)::bigint AS active_users,
    COUNT(DISTINCT chat_id)::bigint AS active_chats,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(*) FILTER (WHERE is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE is_fallback = true AND fallback_success = true)::bigint AS fallback_success_count,
    eta.stats AS error_type_stats,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM request_base
  CROSS JOIN duration_stats ds
  CROSS JOIN error_type_agg eta
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta
  GROUP BY ds.p50, ds.p95, ds.p99, eta.stats, sa.stats, ta.stats;
END;
$$;

CREATE OR REPLACE FUNCTION aggregate_daily_stats(
  p_day_start timestamp with time zone,
  p_day_end timestamp with time zone
)
RETURNS TABLE(
  message_count bigint,
  success_count bigint,
  failure_count bigint,
  timeout_count bigint,
  success_rate numeric,
  avg_duration numeric,
  total_token_usage bigint,
  unique_users bigint,
  unique_chats bigint,
  fallback_count bigint,
  fallback_success_count bigint,
  fallback_affected_users bigint,
  avg_queue_duration numeric,
  avg_prep_duration numeric,
  error_type_stats jsonb
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH request_base AS (
    SELECT *
    FROM message_processing_records m
    WHERE m.received_at >= p_day_start
      AND m.received_at < p_day_end
  ),
  error_type_agg AS (
    SELECT COALESCE(
      jsonb_object_agg(sub.error_type, sub.error_count),
      '{}'::jsonb
    ) AS stats
    FROM (
      SELECT
        error_type,
        COUNT(*)::int AS error_count
      FROM (
        SELECT COALESCE(alert_type, 'unknown') AS error_type
        FROM request_base
        WHERE status = 'failure'

        UNION ALL

        SELECT 'timeout'::text AS error_type
        FROM request_base
        WHERE status = 'timeout'
      ) error_rows
      GROUP BY error_type
    ) sub
  )
  SELECT
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE status = 'failure')::bigint AS failure_count,
    COUNT(*) FILTER (WHERE status = 'timeout')::bigint AS timeout_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END,
      2
    )::numeric AS success_rate,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE status = 'success' AND total_duration > 0), 0))::numeric AS avg_duration,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(DISTINCT user_id)::bigint AS unique_users,
    COUNT(DISTINCT chat_id)::bigint AS unique_chats,
    COUNT(*) FILTER (WHERE is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE is_fallback = true AND fallback_success = true)::bigint AS fallback_success_count,
    COUNT(DISTINCT user_id) FILTER (WHERE is_fallback = true)::bigint AS fallback_affected_users,
    ROUND(COALESCE(AVG(queue_duration) FILTER (WHERE queue_duration > 0), 0))::numeric AS avg_queue_duration,
    ROUND(COALESCE(AVG(prep_duration) FILTER (WHERE prep_duration > 0), 0))::numeric AS avg_prep_duration,
    eta.stats AS error_type_stats
  FROM request_base
  CROSS JOIN error_type_agg eta
  GROUP BY eta.stats;
END;
$$;
