-- ============================================================
-- Migration: add_bot_identity_to_user_activity
-- 2026-04-27
--
-- Adds hosted bot identity to user_activity so /web/users can show
-- which bot account handled each conversation.
-- ============================================================

ALTER TABLE user_activity
  ADD COLUMN IF NOT EXISTS bot_user_id text,
  ADD COLUMN IF NOT EXISTS im_bot_id text;

COMMENT ON COLUMN user_activity.bot_user_id IS '托管 bot 企微 userId / 昵称（回调 botUserId）';
COMMENT ON COLUMN user_activity.im_bot_id IS '托管 bot 系统 wxid（回调 imBotId）';

WITH latest_identity AS (
  SELECT DISTINCT ON (chat_id, activity_date)
    chat_id,
    activity_date,
    NULLIF(manager_name, '') AS bot_user_id,
    NULLIF(im_bot_id, '') AS im_bot_id
  FROM (
    SELECT
      chat_id,
      (timestamp AT TIME ZONE 'Asia/Shanghai')::date AS activity_date,
      manager_name,
      im_bot_id,
      timestamp
    FROM chat_messages
    WHERE manager_name IS NOT NULL
       OR im_bot_id IS NOT NULL
  ) source
  ORDER BY chat_id, activity_date, timestamp DESC
)
UPDATE user_activity ua
SET
  bot_user_id = COALESCE(ua.bot_user_id, latest_identity.bot_user_id),
  im_bot_id = COALESCE(ua.im_bot_id, latest_identity.im_bot_id)
FROM latest_identity
WHERE ua.chat_id = latest_identity.chat_id
  AND ua.activity_date = latest_identity.activity_date
  AND (ua.bot_user_id IS NULL OR ua.im_bot_id IS NULL);

DROP FUNCTION IF EXISTS upsert_user_activity(text, text, text, text, text, integer, integer, timestamptz);

CREATE OR REPLACE FUNCTION upsert_user_activity(
  p_chat_id text,
  p_od_id text DEFAULT NULL,
  p_od_name text DEFAULT NULL,
  p_group_id text DEFAULT NULL,
  p_group_name text DEFAULT NULL,
  p_message_count integer DEFAULT 1,
  p_token_usage integer DEFAULT 0,
  p_active_at timestamptz DEFAULT now(),
  p_bot_user_id text DEFAULT NULL,
  p_im_bot_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_date date := (p_active_at AT TIME ZONE 'Asia/Shanghai')::date;
BEGIN
  INSERT INTO user_activity (
    chat_id, od_id, od_name, group_id, group_name,
    bot_user_id, im_bot_id,
    activity_date, message_count, token_usage,
    first_active_at, last_active_at
  ) VALUES (
    p_chat_id, p_od_id, p_od_name, p_group_id, p_group_name,
    p_bot_user_id, p_im_bot_id,
    v_date, p_message_count, p_token_usage,
    p_active_at, p_active_at
  )
  ON CONFLICT (chat_id, activity_date) DO UPDATE SET
    od_id        = COALESCE(EXCLUDED.od_id, user_activity.od_id),
    od_name      = COALESCE(EXCLUDED.od_name, user_activity.od_name),
    group_id     = COALESCE(EXCLUDED.group_id, user_activity.group_id),
    group_name   = COALESCE(EXCLUDED.group_name, user_activity.group_name),
    bot_user_id  = COALESCE(EXCLUDED.bot_user_id, user_activity.bot_user_id),
    im_bot_id    = COALESCE(EXCLUDED.im_bot_id, user_activity.im_bot_id),
    message_count = user_activity.message_count + EXCLUDED.message_count,
    token_usage   = user_activity.token_usage + EXCLUDED.token_usage,
    last_active_at = EXCLUDED.last_active_at,
    updated_at     = now();
END;
$$;

COMMENT ON FUNCTION upsert_user_activity IS '按天 upsert 用户活跃记录，冲突时累加 message_count/token_usage，并保留托管 bot 身份';

DROP FUNCTION IF EXISTS get_active_users_from_user_activity_by_range(timestamptz, timestamptz);

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
  bot_user_id     text,
  im_bot_id       text,
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
    (ARRAY_AGG(bot_user_id ORDER BY last_active_at DESC) FILTER (WHERE bot_user_id IS NOT NULL))[1]
                                  AS bot_user_id,
    (ARRAY_AGG(im_bot_id ORDER BY last_active_at DESC) FILTER (WHERE im_bot_id IS NOT NULL))[1]
                                  AS im_bot_id,
    SUM(message_count)::bigint    AS message_count,
    SUM(token_usage)::bigint      AS token_usage,
    MIN(first_active_at)          AS first_active_at,
    MAX(last_active_at)           AS last_active_at
  FROM user_activity
  WHERE activity_date >= (p_start_date AT TIME ZONE 'Asia/Shanghai')::date
    AND activity_date <= (p_end_date   AT TIME ZONE 'Asia/Shanghai')::date
  GROUP BY chat_id
  ORDER BY
    (ARRAY_AGG(bot_user_id ORDER BY last_active_at DESC) FILTER (WHERE bot_user_id IS NOT NULL))[1] NULLS LAST,
    MAX(last_active_at) DESC,
    chat_id ASC;
$$;

COMMENT ON FUNCTION get_active_users_from_user_activity_by_range IS
  '按日期范围从 user_activity 聚合活跃用户，返回托管 bot 身份（时区 Asia/Shanghai）';
