-- ============================================================
-- Migration: Fix message_processing_records semantics
-- 2026-04-02
--
-- Goals:
-- 1. Normalize primary semantics for single-message rows
-- 2. Remove duplicated invocation-level payload from merged secondary rows
-- 3. Redefine dashboard/RPC aggregations so message metrics and invocation metrics
--    use the correct source rows
-- ============================================================

-- 单条消息天然就是主消息
UPDATE message_processing_records
SET is_primary = true
WHERE batch_id IS NULL
  AND COALESCE(is_primary, false) = false;

-- 聚合批次中的非主消息不再承载 invocation 级字段，避免 token/tools/fallback 被重复统计
UPDATE message_processing_records
SET token_usage = NULL,
    tools = NULL,
    agent_invocation = NULL,
    is_fallback = false,
    fallback_success = NULL,
    reply_preview = NULL,
    reply_segments = 0
WHERE batch_id IS NOT NULL
  AND COALESCE(is_primary, false) = false;

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
    COUNT(*)::bigint as total_messages,
    COUNT(*) FILTER (WHERE status = 'success')::bigint as success_count,
    COUNT(*) FILTER (WHERE status != 'success')::bigint as failure_count,
    ROUND(
      CASE
        WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END, 2
    ) as success_rate,
    ROUND(
      COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0),
      0
    ) as avg_duration,
    COUNT(DISTINCT user_id)::bigint as active_users,
    COUNT(DISTINCT chat_id)::bigint as active_chats,
    COALESCE(
      SUM(token_usage) FILTER (
        WHERE token_usage IS NOT NULL
          AND COALESCE(is_primary, batch_id IS NULL)
      ),
      0
    )::bigint as total_token_usage
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
    COUNT(*) FILTER (
      WHERE m.is_fallback = true
        AND COALESCE(m.is_primary, m.batch_id IS NULL)
    )::bigint as fallback_total,
    COUNT(*) FILTER (
      WHERE m.is_fallback = true
        AND m.fallback_success = true
        AND COALESCE(m.is_primary, m.batch_id IS NULL)
    )::bigint as fallback_success,
    ROUND(
      CASE
        WHEN COUNT(*) FILTER (
          WHERE m.is_fallback = true
            AND COALESCE(m.is_primary, m.batch_id IS NULL)
        ) > 0
        THEN (
          COUNT(*) FILTER (
            WHERE m.is_fallback = true
              AND m.fallback_success = true
              AND COALESCE(m.is_primary, m.batch_id IS NULL)
          )::numeric
          /
          COUNT(*) FILTER (
            WHERE m.is_fallback = true
              AND COALESCE(m.is_primary, m.batch_id IS NULL)
          )::numeric
        ) * 100
        ELSE 0
      END, 2
    ) as fallback_success_rate,
    COUNT(DISTINCT m.user_id) FILTER (
      WHERE m.is_fallback = true
        AND COALESCE(m.is_primary, m.batch_id IS NULL)
    )::bigint as fallback_affected_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
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
    date_trunc('hour', m.received_at) as hour,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(
      COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0),
      0
    ) as avg_duration,
    COALESCE(
      SUM(m.token_usage) FILTER (
        WHERE m.token_usage IS NOT NULL
          AND COALESCE(m.is_primary, m.batch_id IS NULL)
      ),
      0
    )::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY date_trunc('hour', m.received_at)
  ORDER BY hour ASC;
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
    DATE(m.received_at) as date,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(
      COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0),
      0
    ) as avg_duration,
    COALESCE(
      SUM(m.token_usage) FILTER (
        WHERE m.token_usage IS NOT NULL
          AND COALESCE(m.is_primary, m.batch_id IS NULL)
      ),
      0
    )::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY DATE(m.received_at)
  ORDER BY date ASC;
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
    tool as tool_name,
    COUNT(*)::bigint as use_count
  FROM message_processing_records,
       unnest(tools) as tool
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
    AND tools IS NOT NULL
    AND array_length(tools, 1) > 0
    AND COALESCE(is_primary, batch_id IS NULL)
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
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE b.status = 'success')::bigint AS success_count,
    COUNT(*) FILTER (WHERE b.status != 'success')::bigint AS failure_count,
    ROUND(
      CASE WHEN COUNT(*) > 0
        THEN (COUNT(*) FILTER (WHERE b.status = 'success')::numeric / COUNT(*)::numeric) * 100
        ELSE 0
      END, 2
    )::numeric AS success_rate,
    ROUND(COALESCE(AVG(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0))::numeric AS avg_duration,
    ROUND(COALESCE(MIN(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0))::numeric AS min_duration,
    ROUND(COALESCE(MAX(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0))::numeric AS max_duration,
    ROUND(ds.p50::numeric) AS p50_duration,
    ROUND(ds.p95::numeric) AS p95_duration,
    ROUND(ds.p99::numeric) AS p99_duration,
    ROUND(COALESCE(AVG(ib.ai_duration) FILTER (WHERE ib.status = 'success' AND ib.ai_duration > 0), 0))::numeric AS avg_ai_duration,
    ROUND(COALESCE(AVG(ib.send_duration) FILTER (WHERE ib.status = 'success' AND ib.send_duration > 0), 0))::numeric AS avg_send_duration,
    COUNT(DISTINCT b.user_id)::bigint AS active_users,
    COUNT(DISTINCT b.chat_id)::bigint AS active_chats,
    COALESCE(SUM(ib.token_usage) FILTER (WHERE ib.token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(*) FILTER (WHERE ib.is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE ib.is_fallback = true AND ib.fallback_success = true)::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM base b
  CROSS JOIN duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta
  LEFT JOIN invocation_base ib ON ib.message_id = b.message_id;
END;
$$;

CREATE OR REPLACE FUNCTION get_active_users_by_range(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS TABLE(
  user_id        text,
  user_name      text,
  chat_id        text,
  message_count  bigint,
  token_usage    bigint,
  first_active_at timestamptz,
  last_active_at  timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    user_id,
    MAX(user_name) AS user_name,
    MAX(chat_id) AS chat_id,
    COUNT(*)::bigint AS message_count,
    COALESCE(
      SUM(token_usage) FILTER (
        WHERE COALESCE(is_primary, batch_id IS NULL)
      ),
      0
    )::bigint AS token_usage,
    MIN(received_at) AS first_active_at,
    MAX(received_at) AS last_active_at
  FROM message_processing_records
  WHERE
    received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
    AND user_id IS NOT NULL
  GROUP BY user_id
  ORDER BY MAX(received_at) DESC;
$$;

CREATE OR REPLACE FUNCTION get_daily_user_stats_by_range(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS TABLE(
  stat_date     text,
  unique_users  bigint,
  message_count bigint,
  token_usage   bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    received_at::date::text AS stat_date,
    COUNT(DISTINCT user_id)::bigint AS unique_users,
    COUNT(*)::bigint AS message_count,
    COALESCE(
      SUM(token_usage) FILTER (
        WHERE COALESCE(is_primary, batch_id IS NULL)
      ),
      0
    )::bigint AS token_usage
  FROM message_processing_records
  WHERE
    received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
  GROUP BY received_at::date
  ORDER BY stat_date;
$$;
