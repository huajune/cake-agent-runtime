-- ============================================================
-- Migration: Add monitoring_daily_stats and strengthen aggregate projections
-- 2026-04-16
-- ============================================================

ALTER TABLE message_processing_records
  ADD COLUMN IF NOT EXISTS alert_type text;

COMMENT ON COLUMN message_processing_records.alert_type IS '失败请求的错误类型（agent/message/delivery/system/merge/unknown）';

ALTER TABLE monitoring_hourly_stats
  ADD COLUMN IF NOT EXISTS timeout_count integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS avg_queue_duration integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS avg_prep_duration integer DEFAULT 0 NOT NULL,
  ADD COLUMN IF NOT EXISTS error_type_stats jsonb DEFAULT '{}'::jsonb NOT NULL;

COMMENT ON COLUMN monitoring_hourly_stats.timeout_count IS '该小时 timeout 请求数';
COMMENT ON COLUMN monitoring_hourly_stats.avg_queue_duration IS '该小时平均处理前等待耗时（毫秒）';
COMMENT ON COLUMN monitoring_hourly_stats.avg_prep_duration IS '该小时平均模型准备耗时（毫秒）';
COMMENT ON COLUMN monitoring_hourly_stats.error_type_stats IS '该小时错误类型分布 JSONB';

CREATE TABLE IF NOT EXISTS monitoring_daily_stats (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  stat_date date NOT NULL,
  message_count integer DEFAULT 0 NOT NULL,
  success_count integer DEFAULT 0 NOT NULL,
  failure_count integer DEFAULT 0 NOT NULL,
  timeout_count integer DEFAULT 0 NOT NULL,
  success_rate numeric DEFAULT 0,
  avg_duration integer DEFAULT 0,
  total_token_usage bigint DEFAULT 0 NOT NULL,
  unique_users integer DEFAULT 0 NOT NULL,
  unique_chats integer DEFAULT 0 NOT NULL,
  fallback_count integer DEFAULT 0 NOT NULL,
  fallback_success_count integer DEFAULT 0 NOT NULL,
  fallback_affected_users integer DEFAULT 0 NOT NULL,
  avg_queue_duration integer DEFAULT 0 NOT NULL,
  avg_prep_duration integer DEFAULT 0 NOT NULL,
  error_type_stats jsonb DEFAULT '{}'::jsonb NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT monitoring_daily_stats_pkey PRIMARY KEY (id),
  CONSTRAINT monitoring_daily_stats_stat_date_key UNIQUE (stat_date)
);

COMMENT ON COLUMN monitoring_daily_stats.total_token_usage IS '该日 Token 消耗总量';
COMMENT ON COLUMN monitoring_daily_stats.unique_users IS '该日唯一用户数';
COMMENT ON COLUMN monitoring_daily_stats.unique_chats IS '该日唯一会话数';
COMMENT ON COLUMN monitoring_daily_stats.fallback_count IS '该日降级次数';
COMMENT ON COLUMN monitoring_daily_stats.fallback_success_count IS '该日降级成功次数';
COMMENT ON COLUMN monitoring_daily_stats.fallback_affected_users IS '该日触发降级的去重用户数';
COMMENT ON COLUMN monitoring_daily_stats.avg_queue_duration IS '该日平均处理前等待耗时（毫秒）';
COMMENT ON COLUMN monitoring_daily_stats.avg_prep_duration IS '该日平均模型准备耗时（毫秒）';
COMMENT ON COLUMN monitoring_daily_stats.error_type_stats IS '该日错误类型分布 JSONB';

CREATE INDEX IF NOT EXISTS idx_monitoring_daily_stats_stat_date
  ON monitoring_daily_stats USING btree (stat_date DESC);

ALTER TABLE monitoring_daily_stats ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'monitoring_daily_stats'
      AND policyname = 'Allow public read'
  ) THEN
    CREATE POLICY "Allow public read"
      ON monitoring_daily_stats
      AS PERMISSIVE
      FOR SELECT
      TO public
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'monitoring_daily_stats'
      AND policyname = 'Service role insert'
  ) THEN
    CREATE POLICY "Service role insert"
      ON monitoring_daily_stats
      AS PERMISSIVE
      FOR INSERT
      TO public
      WITH CHECK (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'monitoring_daily_stats'
      AND policyname = 'Service role update'
  ) THEN
    CREATE POLICY "Service role update"
      ON monitoring_daily_stats
      AS PERMISSIVE
      FOR UPDATE
      TO public
      USING (((SELECT auth.role() AS role) = 'service_role'::text))
      WITH CHECK (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'monitoring_daily_stats'
      AND policyname = 'Service role delete'
  ) THEN
    CREATE POLICY "Service role delete"
      ON monitoring_daily_stats
      AS PERMISSIVE
      FOR DELETE
      TO public
      USING (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END $$;

DROP FUNCTION IF EXISTS aggregate_hourly_stats(timestamp with time zone, timestamp with time zone);

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
    COUNT(*) FILTER (WHERE status != 'success')::bigint AS failure_count,
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
  CROSS JOIN tool_agg ta;
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
    COUNT(*) FILTER (WHERE status != 'success')::bigint AS failure_count,
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
  CROSS JOIN error_type_agg eta;
END;
$$;
