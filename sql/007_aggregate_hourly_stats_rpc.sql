-- ============================================
-- 数据库级小时聚合 RPC
-- 替代 TypeScript 侧的聚合逻辑，解决 limit 2000 bug
-- 在 PostgreSQL 内完成全量聚合，包含百分位计算
-- ============================================

CREATE OR REPLACE FUNCTION aggregate_hourly_stats(
  p_hour_start timestamptz,
  p_hour_end timestamptz
)
RETURNS TABLE (
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
      FROM base b
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
    ) AS success_rate,
    ROUND(COALESCE(AVG(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS avg_duration,
    ROUND(COALESCE(MIN(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS min_duration,
    ROUND(COALESCE(MAX(b.total_duration) FILTER (WHERE b.status = 'success' AND b.total_duration > 0), 0)) AS max_duration,
    ROUND(ds.p50) AS p50_duration,
    ROUND(ds.p95) AS p95_duration,
    ROUND(ds.p99) AS p99_duration,
    ROUND(COALESCE(AVG(b.ai_duration) FILTER (WHERE b.status = 'success' AND b.ai_duration > 0), 0)) AS avg_ai_duration,
    ROUND(COALESCE(AVG(b.send_duration) FILTER (WHERE b.status = 'success' AND b.send_duration > 0), 0)) AS avg_send_duration,
    COUNT(DISTINCT b.user_id)::bigint AS active_users,
    COUNT(DISTINCT b.chat_id)::bigint AS active_chats,
    COALESCE(SUM(b.token_usage) FILTER (WHERE b.token_usage IS NOT NULL), 0)::bigint AS total_token_usage,
    COUNT(*) FILTER (WHERE b.is_fallback = true)::bigint AS fallback_count,
    COUNT(*) FILTER (WHERE b.is_fallback = true AND b.fallback_success = true)::bigint AS fallback_success_count,
    sa.stats AS scenario_stats,
    ta.stats AS tool_stats
  FROM base b
  CROSS JOIN duration_stats ds
  CROSS JOIN scenario_agg sa
  CROSS JOIN tool_agg ta
  GROUP BY ds.p50, ds.p95, ds.p99, sa.stats, ta.stats;
END;
$$;

COMMENT ON FUNCTION aggregate_hourly_stats(timestamptz, timestamptz)
IS '数据库级小时聚合：全量扫描 message_processing_records，返回完整的小时统计（含百分位、场景、工具、降级统计）';
