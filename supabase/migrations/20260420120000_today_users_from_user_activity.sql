-- ============================================================
-- Migration: today_users_from_user_activity
-- 2026-04-20
--
-- 背景：
-- 今日托管用户列表原本经 RPC get_active_users_by_range 从
-- message_processing_records（流水表）GROUP BY 聚合并过滤 status='success'，
-- 导致三个问题：
--   1. 处理中 / 处理失败的用户不会出现；
--   2. 流水表扫描 + 聚合代价高；
--   3. 与 user_activity（按天聚合表）写入口径脱节，形成只写不读。
--
-- 本 migration 新增 get_active_users_from_user_activity_by_range，
-- 直接读 user_activity。时区口径与 upsert_user_activity 对齐（Asia/Shanghai），
-- 保证按日期过滤不漏数。
-- ============================================================

CREATE OR REPLACE FUNCTION get_active_users_from_user_activity_by_range(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS TABLE(
  chat_id         text,
  od_id           text,
  od_name         text,
  group_id        text,
  group_name      text,
  message_count   bigint,
  token_usage     bigint,
  first_active_at timestamptz,
  last_active_at  timestamptz
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    chat_id,
    MAX(od_id)                    AS od_id,
    MAX(od_name)                  AS od_name,
    MAX(group_id)                 AS group_id,
    MAX(group_name)               AS group_name,
    SUM(message_count)::bigint    AS message_count,
    SUM(token_usage)::bigint      AS token_usage,
    MIN(first_active_at)          AS first_active_at,
    MAX(last_active_at)           AS last_active_at
  FROM user_activity
  WHERE activity_date >= (p_start_date AT TIME ZONE 'Asia/Shanghai')::date
    AND activity_date <= (p_end_date   AT TIME ZONE 'Asia/Shanghai')::date
  GROUP BY chat_id
  ORDER BY MAX(last_active_at) DESC;
$$;

COMMENT ON FUNCTION get_active_users_from_user_activity_by_range IS
  '按日期范围从 user_activity 聚合活跃用户（时区 Asia/Shanghai，与 upsert_user_activity 对齐）';
