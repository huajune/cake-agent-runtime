-- ============================================================
-- Migration: add_upsert_user_activity
-- 2026-03-23
--
-- Adds the missing upsert_user_activity RPC function.
-- Called by UserHostingRepository to record per-day user activity.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_user_activity(
  p_chat_id text,
  p_od_id text DEFAULT NULL,
  p_od_name text DEFAULT NULL,
  p_group_id text DEFAULT NULL,
  p_group_name text DEFAULT NULL,
  p_message_count integer DEFAULT 1,
  p_token_usage integer DEFAULT 0,
  p_active_at timestamptz DEFAULT now()
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_date date := (p_active_at AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  INSERT INTO user_activity (
    chat_id, od_id, od_name, group_id, group_name,
    activity_date, message_count, token_usage,
    first_active_at, last_active_at
  ) VALUES (
    p_chat_id, p_od_id, p_od_name, p_group_id, p_group_name,
    v_date, p_message_count, p_token_usage,
    p_active_at, p_active_at
  )
  ON CONFLICT (chat_id, activity_date) DO UPDATE SET
    od_id        = COALESCE(EXCLUDED.od_id, user_activity.od_id),
    od_name      = COALESCE(EXCLUDED.od_name, user_activity.od_name),
    group_id     = COALESCE(EXCLUDED.group_id, user_activity.group_id),
    group_name   = COALESCE(EXCLUDED.group_name, user_activity.group_name),
    message_count = user_activity.message_count + EXCLUDED.message_count,
    token_usage   = user_activity.token_usage + EXCLUDED.token_usage,
    last_active_at = EXCLUDED.last_active_at,
    updated_at     = now();
END;
$$;

COMMENT ON FUNCTION upsert_user_activity IS '按天 upsert 用户活跃记录，冲突时累加 message_count 和 token_usage';
