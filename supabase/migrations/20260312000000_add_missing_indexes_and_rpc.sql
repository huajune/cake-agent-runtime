-- ============================================================
-- Migration: Add missing indexes and RPC functions
-- 2026-03-12
--
-- Changes:
-- 1. Add chat_messages(chat_id, timestamp DESC) composite index
-- 2. Add message_processing_records(user_id), (chat_id) indexes
-- 3. Add user_activity(activity_date) index
-- 4. Add RPC get_active_users_by_range()
-- 5. Add RPC get_daily_user_stats_by_range()
-- 6. Add RPC increment_booking_count() for atomic upsert+increment
-- ============================================================

-- ============================================================
-- 1. Missing indexes
-- ============================================================

-- chat_messages: 按 chat_id 过滤是最高频查询维度，缺失此索引导致全表扫描
CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_id
  ON chat_messages(chat_id, timestamp DESC);

-- message_processing_records: getActiveUsers / getDailyUserStats 按 user_id 聚合
CREATE INDEX IF NOT EXISTS idx_message_processing_user_id
  ON message_processing_records(user_id)
  WHERE user_id IS NOT NULL;

-- message_processing_records: 按 chat_id 查询
CREATE INDEX IF NOT EXISTS idx_message_processing_chat_id
  ON message_processing_records(chat_id);

-- user_activity: 按日期范围清理和查询
CREATE INDEX IF NOT EXISTS idx_user_activity_date
  ON user_activity(activity_date);

-- ============================================================
-- 2. RPC: 活跃用户聚合（替代应用层 JS 聚合）
-- ============================================================

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
    MAX(user_name)      AS user_name,
    MAX(chat_id)        AS chat_id,
    COUNT(*)::bigint    AS message_count,
    COALESCE(SUM(token_usage), 0)::bigint AS token_usage,
    MIN(received_at)    AS first_active_at,
    MAX(received_at)    AS last_active_at
  FROM message_processing_records
  WHERE
    received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
    AND user_id IS NOT NULL
  GROUP BY user_id
  ORDER BY MAX(received_at) DESC;
$$;

COMMENT ON FUNCTION get_active_users_by_range IS
  '按时间范围查询活跃用户列表（DB 聚合，替代应用层 JS 聚合）';

-- ============================================================
-- 3. RPC: 每日用户统计聚合（替代应用层 JS 聚合）
-- ============================================================

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
    received_at::date::text          AS stat_date,
    COUNT(DISTINCT user_id)::bigint  AS unique_users,
    COUNT(*)::bigint                 AS message_count,
    COALESCE(SUM(token_usage), 0)::bigint AS token_usage
  FROM message_processing_records
  WHERE
    received_at >= p_start_date
    AND received_at <= p_end_date
    AND status = 'success'
  GROUP BY received_at::date
  ORDER BY stat_date;
$$;

COMMENT ON FUNCTION get_daily_user_stats_by_range IS
  '按时间范围统计每日用户数据（DB 聚合，替代应用层 JS 聚合）';

-- ============================================================
-- 4. RPC: 预约记录原子性递增（修复 INSERT 约束冲突问题）
-- ============================================================

CREATE OR REPLACE FUNCTION increment_booking_count(
  p_date         date,
  p_brand_name   text,
  p_store_name   text,
  p_chat_id      text,
  p_user_id      text,
  p_user_name    text,
  p_manager_id   text,
  p_manager_name text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO interview_booking_records (
    date, brand_name, store_name, booking_count,
    chat_id, user_id, user_name, manager_id, manager_name
  ) VALUES (
    p_date, p_brand_name, p_store_name, 1,
    p_chat_id, p_user_id, p_user_name, p_manager_id, p_manager_name
  )
  ON CONFLICT ON CONSTRAINT booking_stats_date_brand_name_store_name_key
  DO UPDATE SET
    booking_count = interview_booking_records.booking_count + 1,
    chat_id       = EXCLUDED.chat_id,
    user_id       = EXCLUDED.user_id,
    user_name     = EXCLUDED.user_name,
    manager_id    = EXCLUDED.manager_id,
    manager_name  = EXCLUDED.manager_name,
    updated_at    = now();
END;
$$;

COMMENT ON FUNCTION increment_booking_count IS
  '原子性地插入或递增预约计数（ON CONFLICT DO UPDATE），修复重复调用导致的唯一约束冲突';
