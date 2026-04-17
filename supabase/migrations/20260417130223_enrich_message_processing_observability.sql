-- 消息处理流水可观测性增强
--
-- 背景：
--   原 tools text[] 列只记录工具名，看不到每次调用的入参/返回条数/耗时，
--   也丢失了多步工具循环的中间思考与结果。Case 1/2 这类"重复查询"
--   与"查完即收尾"问题无法通过表直接定位。
--
-- 本次变更：
--   1. 丢弃 tools text[]，用 tool_calls jsonb 保存每次调用详情
--      ([{ toolName, args, result, resultCount, status, durationMs }, ...])
--   2. 新增 agent_steps jsonb 保存每步模型思考/工具调用
--      ([{ stepIndex, text, reasoning, toolCalls, usage, durationMs }, ...])
--   3. 新增 anomaly_flags text[] 写入时打标
--      (tool_loop / tool_empty_result / tool_narrow_result / tool_chain_overlong / no_tool_called)
--   4. 新增 memory_snapshot jsonb 记录本轮触发时的记忆上下文
--      ({ currentStage, presentedJobIds, recommendedJobIds, sessionFacts, profileKeys })
--   5. 重写 aggregate_hourly_stats.tool_agg: 从 tool_calls jsonb 取 toolName 而非 unnest(tools)

-- 1. 移除旧列，新增 4 列
ALTER TABLE message_processing_records
  DROP COLUMN IF EXISTS tools,
  ADD COLUMN IF NOT EXISTS tool_calls jsonb,
  ADD COLUMN IF NOT EXISTS agent_steps jsonb,
  ADD COLUMN IF NOT EXISTS anomaly_flags text[],
  ADD COLUMN IF NOT EXISTS memory_snapshot jsonb;

COMMENT ON COLUMN message_processing_records.tool_calls IS
  '工具调用详情 JSONB：[{ toolName, args, result, resultCount, status, durationMs }, ...]';
COMMENT ON COLUMN message_processing_records.agent_steps IS
  '多步循环每步快照 JSONB：[{ stepIndex, text, reasoning, toolCalls, usage, durationMs }, ...]';
COMMENT ON COLUMN message_processing_records.anomaly_flags IS
  '异常信号数组：tool_loop/tool_empty_result/tool_narrow_result/tool_chain_overlong/no_tool_called';
COMMENT ON COLUMN message_processing_records.memory_snapshot IS
  '本轮触发时的记忆快照：currentStage/presentedJobIds/recommendedJobIds/sessionFacts/profileKeys';

-- 2. anomaly_flags 支持 ANY() / @> 查询
CREATE INDEX IF NOT EXISTS idx_message_processing_records_anomaly_flags
  ON message_processing_records USING gin (anomaly_flags);

-- 3. 重写 aggregate_hourly_stats：tool_agg 从 tool_calls jsonb 读
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

-- 4. 重写 get_dashboard_tool_stats：从 tool_calls jsonb 读工具名
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
    (call_entry->>'toolName')::text AS tool_name,
    COUNT(*)::bigint AS use_count
  FROM message_processing_records m,
       jsonb_array_elements(m.tool_calls) AS call_entry
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
    AND m.tool_calls IS NOT NULL
    AND jsonb_typeof(m.tool_calls) = 'array'
    AND jsonb_array_length(m.tool_calls) > 0
    AND call_entry->>'toolName' IS NOT NULL
  GROUP BY call_entry->>'toolName'
  ORDER BY use_count DESC;
END;
$$;
