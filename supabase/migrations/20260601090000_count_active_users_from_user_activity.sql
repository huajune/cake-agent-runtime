-- ============================================================
-- Migration: count_active_users_from_user_activity
-- 2026-06-01
--
-- Dashboard 的“托管用户数”只需要日期范围内的去重用户总数。
-- 之前应用层通过列表型 RPC 的返回行数计算，总数超过 PostgREST
-- max_rows(默认 1000) 时会被截断成 1000。
-- ============================================================

CREATE OR REPLACE FUNCTION count_active_users_from_user_activity_by_range(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(DISTINCT chat_id)::bigint
  FROM user_activity
  WHERE activity_date >= (p_start_date AT TIME ZONE 'Asia/Shanghai')::date
    AND activity_date <= (p_end_date   AT TIME ZONE 'Asia/Shanghai')::date;
$$;

COMMENT ON FUNCTION count_active_users_from_user_activity_by_range IS
  '按日期范围从 user_activity 统计去重活跃用户数（时区 Asia/Shanghai），避免列表 RPC 1000 行上限影响总数';
