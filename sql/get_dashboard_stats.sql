-- Dashboard 统计聚合函数
-- 用于仪表盘的核心指标展示，通过 SQL 聚合替代应用层计算
--
-- 包含以下统计：
-- 1. 基础指标：消息总数、成功率、平均响应时间、活跃用户/会话数
-- 2. 降级统计：降级次数、降级成功率
-- 3. 业务指标：托管用户数、Token 消耗

-- =====================================================
-- 函数1: get_dashboard_overview_stats
-- 获取 Dashboard 概览统计（核心指标）
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_overview_stats(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
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
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL AND total_duration > 0), 0), 0) as avg_duration,
    COUNT(DISTINCT user_id)::bigint as active_users,
    COUNT(DISTINCT chat_id)::bigint as active_chats,
    COALESCE(SUM(token_usage) FILTER (WHERE token_usage IS NOT NULL), 0)::bigint as total_token_usage
  FROM message_processing_records
  WHERE received_at >= p_start_date
    AND received_at < p_end_date;
END;
$$;

COMMENT ON FUNCTION get_dashboard_overview_stats(timestamptz, timestamptz)
IS 'Dashboard 概览统计：消息总数、成功率、平均耗时、活跃用户/会话、Token消耗';

-- =====================================================
-- 函数2: get_dashboard_fallback_stats
-- 获取降级统计
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_fallback_stats(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
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
    COUNT(*) FILTER (WHERE m.is_fallback = true)::bigint as fallback_total,
    COUNT(*) FILTER (WHERE m.is_fallback = true AND m.fallback_success = true)::bigint as fallback_success,
    ROUND(
      CASE
        WHEN COUNT(*) FILTER (WHERE m.is_fallback = true) > 0
        THEN (COUNT(*) FILTER (WHERE m.is_fallback = true AND m.fallback_success = true)::numeric
              / COUNT(*) FILTER (WHERE m.is_fallback = true)::numeric) * 100
        ELSE 0
      END, 2
    ) as fallback_success_rate,
    COUNT(DISTINCT m.user_id) FILTER (WHERE m.is_fallback = true)::bigint as fallback_affected_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date;
END;
$$;

COMMENT ON FUNCTION get_dashboard_fallback_stats(timestamptz, timestamptz)
IS 'Dashboard 降级统计：降级次数、成功率、受影响用户数';

-- =====================================================
-- 函数3: get_dashboard_hourly_trend
-- 获取小时级趋势数据（用于响应时间趋势图和 Token 消耗图）
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_hourly_trend(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
  hour timestamptz,
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
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COALESCE(SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL), 0)::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY date_trunc('hour', m.received_at)
  ORDER BY hour ASC;
END;
$$;

COMMENT ON FUNCTION get_dashboard_hourly_trend(timestamptz, timestamptz)
IS 'Dashboard 小时级趋势：每小时消息数、成功数、平均耗时、Token消耗、用户数';

-- =====================================================
-- 函数4: get_dashboard_minute_trend
-- 获取分钟级趋势数据（用于实时监控图表）
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_minute_trend(
  p_start_date timestamptz,
  p_end_date timestamptz,
  p_interval_minutes int DEFAULT 5
)
RETURNS TABLE (
  minute timestamptz,
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
      (EXTRACT(minute FROM m.received_at)::int % p_interval_minutes) * interval '1 minute' as minute,
    COUNT(*)::bigint as message_count,
    COUNT(*) FILTER (WHERE m.status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY date_trunc('minute', m.received_at) -
      (EXTRACT(minute FROM m.received_at)::int % p_interval_minutes) * interval '1 minute'
  ORDER BY minute ASC;
END;
$$;

COMMENT ON FUNCTION get_dashboard_minute_trend(timestamptz, timestamptz, int)
IS 'Dashboard 分钟级趋势：可配置间隔的消息统计';

-- =====================================================
-- 函数5: get_dashboard_daily_trend
-- 获取每日趋势数据（用于 Token 消耗图等）
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_daily_trend(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
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
    ROUND(COALESCE(AVG(m.total_duration) FILTER (WHERE m.total_duration IS NOT NULL AND m.total_duration > 0), 0), 0) as avg_duration,
    COALESCE(SUM(m.token_usage) FILTER (WHERE m.token_usage IS NOT NULL), 0)::bigint as token_usage,
    COUNT(DISTINCT m.user_id)::bigint as unique_users
  FROM message_processing_records m
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
  GROUP BY DATE(m.received_at)
  ORDER BY date ASC;
END;
$$;

COMMENT ON FUNCTION get_dashboard_daily_trend(timestamptz, timestamptz)
IS 'Dashboard 每日趋势：消息数、成功数、平均耗时、Token消耗、用户数';

-- =====================================================
-- 函数6: get_dashboard_scenario_stats
-- 获取场景分布统计
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_scenario_stats(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
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
    COALESCE(m.scenario, 'unknown') as scenario,
    COUNT(*)::bigint as count,
    COUNT(*) FILTER (WHERE status = 'success')::bigint as success_count,
    ROUND(COALESCE(AVG(total_duration) FILTER (WHERE total_duration IS NOT NULL), 0), 0) as avg_duration
  FROM message_processing_records m
  WHERE received_at >= p_start_date
    AND received_at < p_end_date
  GROUP BY m.scenario
  ORDER BY count DESC;
END;
$$;

COMMENT ON FUNCTION get_dashboard_scenario_stats(timestamptz, timestamptz)
IS 'Dashboard 场景分布统计';

-- =====================================================
-- 函数7: get_dashboard_tool_stats
-- 获取工具使用统计
-- =====================================================
CREATE OR REPLACE FUNCTION get_dashboard_tool_stats(
  p_start_date timestamptz,
  p_end_date timestamptz
)
RETURNS TABLE (
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
  GROUP BY tool
  ORDER BY use_count DESC;
END;
$$;

COMMENT ON FUNCTION get_dashboard_tool_stats(timestamptz, timestamptz)
IS 'Dashboard 工具使用统计';
