-- ============================================================
-- fix_dashboard_tool_stats_from_tool_calls
-- 2026-05-29
--
-- get_dashboard_tool_stats 改为从 message_processing_records.tool_calls
-- （jsonb 数组）逐个工具调用聚合「工具使用次数」，而非旧版的口径。
--
-- ⚠️ 溯源说明：此迁移此前被直接应用到生产（uvmbxcilpteaiizplcyp），但迁移
--    文件从未提交进仓库 —— 导致远端迁移历史有 20260529142000、本地任何分支却无
--    对应文件，`supabase db push` 因一致性校验失败。本文件按生产当前的函数定义
--    （pg_get_functiondef）如实补档，使本地与远端对齐；CREATE OR REPLACE 幂等，
--    重复应用无副作用。
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_tool_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(tool_name text, use_count bigint)
LANGUAGE plpgsql
AS $function$
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
    AND call_entry->>'toolName' <> ''
  GROUP BY call_entry->>'toolName'
  ORDER BY use_count DESC;
END;
$function$;
