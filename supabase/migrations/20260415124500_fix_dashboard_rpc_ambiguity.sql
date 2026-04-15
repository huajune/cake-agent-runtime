-- ============================================================
-- Migration: Fix dashboard RPC ambiguity in PL/pgSQL functions
-- 2026-04-15
--
-- get_dashboard_* 系列函数在 20260414152000 中改写后，
-- RETURNS TABLE 输出参数名与 message_processing_records 列名发生冲突。
-- 在 PL/pgSQL 中，未限定的 fallback_success / token_usage / scenario
-- 会与输出变量重名，导致 RPC 执行时报 42702 ambiguous_column。
--
-- 这里统一改为显式表别名 + 位置排序，避免后续再次踩坑。
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
    COUNT(*) FILTER (WHERE m.is_fallback = true)::bigint AS fallback_total,
    COUNT(*) FILTER (
      WHERE m.is_fallback = true
        AND m.fallback_success = true
    )::bigint AS fallback_success,
    ROUND(
      CASE
        WHEN COUNT(*) FILTER (WHERE m.is_fallback = true) > 0
        THEN (
          COUNT(*) FILTER (
            WHERE m.is_fallback = true
              AND m.fallback_success = true
          )::numeric
          /
          COUNT(*) FILTER (WHERE m.is_fallback = true)::numeric
        ) * 100
        ELSE 0
      END,
      2
    ) AS fallback_success_rate,
    COUNT(DISTINCT m.user_id) FILTER (
      WHERE m.is_fallback = true
    )::bigint AS fallback_affected_users
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
    date_trunc('hour', m.received_at) AS hour,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
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
    COALESCE(
      SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL),
      0
    )::bigint AS token_usage,
    COUNT(DISTINCT m.user_id)::bigint AS unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY 1
  ORDER BY 1 ASC;
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
    date_trunc('minute', m.received_at) -
      (EXTRACT(minute FROM m.received_at)::int % p_interval_minutes) * interval '1 minute' AS minute,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
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
    COUNT(DISTINCT m.user_id)::bigint AS unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY 1
  ORDER BY 1 ASC;
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
    DATE(m.received_at) AS date,
    COUNT(*)::bigint AS message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
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
    COALESCE(
      SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL),
      0
    )::bigint AS token_usage,
    COUNT(DISTINCT m.user_id)::bigint AS unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY 1
  ORDER BY 1 ASC;
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
    COALESCE(m.scenario, 'unknown') AS scenario,
    COUNT(*)::bigint AS count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint AS success_count,
    ROUND(
      COALESCE(
        AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL),
        0
      ),
      0
    ) AS avg_duration
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY 1
  ORDER BY 2 DESC;
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
    t.tool_name,
    COUNT(*)::bigint AS use_count
  FROM message_processing_records m
  CROSS JOIN LATERAL unnest(m.tools) AS t(tool_name)
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
    AND m.tools IS NOT NULL
    AND array_length(m.tools, 1) > 0
  GROUP BY 1
  ORDER BY 2 DESC;
END;
$$;
