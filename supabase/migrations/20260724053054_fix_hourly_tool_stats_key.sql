-- ============================================================
-- 修复 aggregate_hourly_stats 的 tool_agg 键名漂移
--
-- 背景：生产库实际生效的函数版本读 call_entry->>'name'，而写入侧
-- （message_processing_records.tool_calls）的键是 'toolName'（仓库
-- 20260417130223 迁移的定义也是 toolName）。取不到键 → tool_stats
-- 自 2026-04-17 起恒为 '{}'，Dashboard「人工介入触发次数」等依赖
-- 小时聚合的工具统计只剩当前小时实时补尾，长期严重低估。
--
-- 处置：
--   1. CREATE OR REPLACE 重推与仓库 20260417130223 一致的定义
--      （tool_agg 读 'toolName'），不依赖 IF NOT EXISTS。
--   2. 幂等回填近 30 天（原始流水保留期）tool_stats 为 '{}' 的小时行。
-- ============================================================

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
        call_entry->>'toolName' AS tool_name,
        COUNT(*)::int AS tool_count
      FROM request_base,
           jsonb_array_elements(tool_calls) AS call_entry
      WHERE tool_calls IS NOT NULL
        AND jsonb_typeof(tool_calls) = 'array'
        AND jsonb_array_length(tool_calls) > 0
        AND call_entry->>'toolName' IS NOT NULL
      GROUP BY call_entry->>'toolName'
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


-- 回填：仅覆盖 tool_stats 为空的小时行，不动修复后新写入的行（幂等）。
WITH per_hour AS (
  SELECT
    date_trunc('hour', m.received_at) AS hr,
    call_entry->>'toolName' AS tool_name,
    COUNT(*)::int AS tool_count
  FROM (
    SELECT received_at, tool_calls
    FROM message_processing_records
    WHERE received_at >= now() - interval '30 days'
      AND tool_calls IS NOT NULL
      AND jsonb_typeof(tool_calls) = 'array'
      AND jsonb_array_length(tool_calls) > 0
  ) m,
  jsonb_array_elements(m.tool_calls) AS call_entry
  WHERE call_entry->>'toolName' IS NOT NULL
  GROUP BY 1, 2
),
agg AS (
  SELECT hr, jsonb_object_agg(tool_name, tool_count) AS stats
  FROM per_hour
  GROUP BY hr
)
UPDATE monitoring_hourly_stats h
SET tool_stats = agg.stats
FROM agg
WHERE h.hour = agg.hr
  AND (h.tool_stats IS NULL OR h.tool_stats = '{}'::jsonb);
