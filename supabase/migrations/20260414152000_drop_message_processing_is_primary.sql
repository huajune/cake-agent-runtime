-- ============================================================
-- Migration: Drop message_processing_records.is_primary
-- 2026-04-14
--
-- 用户已确认不需要保留旧语义兼容，允许直接清理旧数据。
-- 最终目标：
-- 1. message_processing_records 只保留请求级流水
-- 2. 删除旧的 merged secondary 历史数据和小时聚合快照
-- 3. 彻底移除 is_primary 列及相关索引/判断
-- ============================================================

-- 清理旧语义数据，避免新旧口径混杂
TRUNCATE TABLE monitoring_hourly_stats RESTART IDENTITY;
TRUNCATE TABLE message_processing_records RESTART IDENTITY;

-- 删除旧兼容索引与列
DROP INDEX IF EXISTS idx_message_batch_primary;
DROP INDEX IF EXISTS idx_message_is_primary;

ALTER TABLE message_processing_records
  DROP COLUMN IF EXISTS is_primary;

COMMENT ON COLUMN message_processing_records.batch_id IS '聚合请求ID；仅合并后的请求会写入该字段';

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
  total_token_usage bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::bigint AS total_messages,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE status != 'success')::bigint AS failure_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END,
      2
    ) AS success_rate,
    ROUND(
      COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0),
      0
    ) AS avg_duration,
    COUNT(DISTINCT user_id)::bigint AS active_users,
    COUNT(DISTINCT chat_id)::bigint AS active_chats,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS total_token_usage
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_fallback_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  fallback_total bigint,
  fallback_success bigint,
  fallback_success_rate numeric,
  fallback_affected_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*) FILTER (WHERE is_fallback = true)::bigint AS fallback_total,
    COUNT(*) FILTER (WHERE is_fallback = true AND fallback_success = true)::bigint AS fallback_success,
    ROUND(
      CASE
        WHEN COUNT(*) FILTER (WHERE is_fallback = true) > 0
        THEN (
          COUNT(*) FILTER (WHERE is_fallback = true AND fallback_success = true)::numeric
          /
          COUNT(*) FILTER (WHERE is_fallback = true)::numeric
        ) * 100
        ELSE 0
      END,
      2
    ) AS fallback_success_rate,
    COUNT(DISTINCT user_id) FILTER (WHERE is_fallback = true)::bigint AS fallback_affected_users
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_hourly_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  hour timestamp with time zone,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  token_usage bigint,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('hour', received_at) AS hour,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    ROUND(
      COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0),
      0
    ) AS avg_duration,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS token_usage,
    COUNT(DISTINCT user_id)::bigint AS unique_users
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY date_trunc('hour', received_at)
  ORDER BY hour ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_minute_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_interval_minutes integer DEFAULT 5
)
RETURNS TABLE(
  minute timestamp with time zone,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    date_trunc('minute', received_at) -
      (EXTRACT(minute FROM received_at)::int % p_interval_minutes) * interval '1 minute' AS minute,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    ROUND(
      COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0),
      0
    ) AS avg_duration,
    COUNT(DISTINCT user_id)::bigint AS unique_users
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY
    date_trunc('minute', received_at) -
      (EXTRACT(minute FROM received_at)::int % p_interval_minutes) * interval '1 minute'
  ORDER BY minute ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_daily_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  date date,
  message_count bigint,
  success_count bigint,
  avg_duration numeric,
  token_usage bigint,
  unique_users bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    DATE(received_at) AS date,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    ROUND(
      COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0),
      0
    ) AS avg_duration,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS token_usage,
    COUNT(DISTINCT user_id)::bigint AS unique_users
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY DATE(received_at)
  ORDER BY date ASC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_scenario_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  scenario text,
  count bigint,
  success_count bigint,
  avg_duration numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(scenario, 'unknown') AS scenario,
    COUNT(*)::bigint AS count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL), 0), 0) AS avg_duration
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY scenario
  ORDER BY count DESC;
END;
$$;

CREATE OR REPLACE FUNCTION get_dashboard_tool_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  tool_name text,
  use_count bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    tool AS tool_name,
    COUNT(*)::bigint AS use_count
  FROM message_processing_records,
       unnest(tools) AS tool
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
    AND tools IS NOT NULL
    AND array_length(tools, 1) > 0
  GROUP BY tool
  ORDER BY use_count DESC;
END;
$$;

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
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE status != 'success')::bigint AS failure_count,
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
    ROUND(COALESCE(AVG(ai_duration) FILTER (WHERE status = 'success' AND ai_duration > 0), 0))::numeric AS avg_ai_duration,
    ROUND(COALESCE(AVG(send_duration) FILTER (WHERE status = 'success' AND send_duration > 0), 0))::numeric AS avg_send_duration,
    COUNT(DISTINCT user_id)::bigint AS active_users,
    COUNT(DISTINCT chat_id)::bigint AS active_chats,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(*) FILTER (WHERE is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE is_fallback = true AND fallback_success = true)::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM request_base
  CROSS JOIN duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta;
END;
$$;

CREATE OR REPLACE FUNCTION get_active_users_by_range(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE(
  user_id text,
  user_name text,
  chat_id text,
  message_count bigint,
  token_usage bigint,
  first_active_at timestamptz,
  last_active_at timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    user_id,
    MAX(user_name) AS user_name,
    MAX(chat_id) AS chat_id,
    COUNT(*)::bigint AS message_count,
    COALESCE(SUM(token_usage), 0)::bigint AS token_usage,
    MIN(received_at) AS first_active_at,
    MAX(received_at) AS last_active_at
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
    AND user_id IS NOT NULL
  GROUP BY user_id
  ORDER BY MAX(received_at) DESC;
$$;

CREATE OR REPLACE FUNCTION get_daily_user_stats_by_range(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE(
  stat_date text,
  unique_users bigint,
  message_count bigint,
  token_usage bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    received_at::date::text AS stat_date,
    COUNT(DISTINCT user_id)::bigint AS unique_users,
    COUNT(*)::bigint AS message_count,
    COALESCE(SUM(token_usage), 0)::bigint AS token_usage
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
  GROUP BY received_at::date
  ORDER BY stat_date;
$$;
