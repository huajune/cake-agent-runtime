-- 修复 20260902073727_retention_schema_audit 删除 user_activity.group_* 后的 RPC 漂移。
--
-- 线上症状：
--   * upsert_user_activity INSERT 漏写 NOT NULL 的 first_active_at / last_active_at，
--     所有新活跃记录均以 23502 失败；
--   * 迁移误重建 get_active_users_from_user_activity（旧函数名），实际调用的
--     get_active_users_from_user_activity_by_range 仍引用已删除的 group_id / group_name，
--     托管用户列表以 42703 失败并显示 0 条。

-- 参数签名未变，可直接原地替换写入 RPC。
CREATE OR REPLACE FUNCTION upsert_user_activity(
  p_chat_id text,
  p_od_id text DEFAULT NULL,
  p_od_name text DEFAULT NULL,
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
    chat_id,
    activity_date,
    od_id,
    od_name,
    message_count,
    token_usage,
    bot_user_id,
    im_bot_id,
    first_active_at,
    last_active_at,
    updated_at
  )
  VALUES (
    p_chat_id,
    v_date,
    p_od_id,
    p_od_name,
    p_message_count,
    p_token_usage,
    p_bot_user_id,
    p_im_bot_id,
    p_active_at,
    p_active_at,
    now()
  )
  ON CONFLICT (chat_id, activity_date) DO UPDATE SET
    od_id          = COALESCE(EXCLUDED.od_id, user_activity.od_id),
    od_name        = COALESCE(EXCLUDED.od_name, user_activity.od_name),
    message_count  = user_activity.message_count + EXCLUDED.message_count,
    token_usage    = user_activity.token_usage + EXCLUDED.token_usage,
    bot_user_id    = COALESCE(EXCLUDED.bot_user_id, user_activity.bot_user_id),
    im_bot_id      = COALESCE(EXCLUDED.im_bot_id, user_activity.im_bot_id),
    first_active_at = LEAST(user_activity.first_active_at, EXCLUDED.first_active_at),
    last_active_at  = GREATEST(user_activity.last_active_at, EXCLUDED.last_active_at),
    updated_at      = now();
END;
$$;

COMMENT ON FUNCTION upsert_user_activity(text, text, text, integer, integer, timestamptz, text, text) IS
  '按上海自然日 upsert 用户活跃记录；累加消息/Token，并保留首末活跃时间和托管 bot 身份';

-- 返回列已删除 group_id / group_name，必须 DROP 后重建，不能 CREATE OR REPLACE 改返回类型。
DROP FUNCTION IF EXISTS get_active_users_from_user_activity_by_range(timestamptz, timestamptz);

CREATE FUNCTION get_active_users_from_user_activity_by_range(
  p_start_date timestamptz,
  p_end_date   timestamptz
)
RETURNS TABLE(
  chat_id         text,
  od_id           text,
  od_name         text,
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
    ua.chat_id,
    MAX(ua.od_id) AS od_id,
    MAX(ua.od_name) AS od_name,
    (ARRAY_AGG(ua.bot_user_id ORDER BY ua.last_active_at DESC)
      FILTER (WHERE ua.bot_user_id IS NOT NULL))[1] AS bot_user_id,
    (ARRAY_AGG(ua.im_bot_id ORDER BY ua.last_active_at DESC)
      FILTER (WHERE ua.im_bot_id IS NOT NULL))[1] AS im_bot_id,
    SUM(ua.message_count)::bigint AS message_count,
    SUM(ua.token_usage)::bigint AS token_usage,
    MIN(ua.first_active_at) AS first_active_at,
    MAX(ua.last_active_at) AS last_active_at
  FROM user_activity ua
  WHERE ua.activity_date >= (p_start_date AT TIME ZONE 'Asia/Shanghai')::date
    AND ua.activity_date <= (p_end_date AT TIME ZONE 'Asia/Shanghai')::date
  GROUP BY ua.chat_id
  ORDER BY MAX(ua.last_active_at) DESC, ua.chat_id ASC;
$$;

COMMENT ON FUNCTION get_active_users_from_user_activity_by_range(timestamptz, timestamptz) IS
  '按日期范围聚合 user_activity 活跃用户；返回稳定排序供 PostgREST 分页拉取';

-- v11.2.0 于 2026-09-02 19:07（Asia/Shanghai）部署后写入持续失败。
-- 用永久保留的 chat_messages 恢复 9 月 2 日起的候选人活跃；message_processing_records
-- 仅补 Token。GREATEST 让回填可重复执行且不会覆盖已有的更大真值。
WITH recovered_messages AS (
  SELECT
    cm.chat_id,
    (cm.timestamp AT TIME ZONE 'Asia/Shanghai')::date AS activity_date,
    (ARRAY_AGG(NULLIF(cm.external_user_id, '') ORDER BY cm.timestamp DESC)
      FILTER (WHERE NULLIF(cm.external_user_id, '') IS NOT NULL))[1] AS od_id,
    (ARRAY_AGG(NULLIF(cm.candidate_name, '') ORDER BY cm.timestamp DESC)
      FILTER (WHERE NULLIF(cm.candidate_name, '') IS NOT NULL))[1] AS od_name,
    (ARRAY_AGG(NULLIF(cm.manager_name, '') ORDER BY cm.timestamp DESC)
      FILTER (WHERE NULLIF(cm.manager_name, '') IS NOT NULL))[1] AS bot_user_id,
    (ARRAY_AGG(NULLIF(cm.im_bot_id, '') ORDER BY cm.timestamp DESC)
      FILTER (WHERE NULLIF(cm.im_bot_id, '') IS NOT NULL))[1] AS im_bot_id,
    COUNT(*)::integer AS message_count,
    MIN(cm.timestamp) AS first_active_at,
    MAX(cm.timestamp) AS last_active_at
  FROM chat_messages cm
  WHERE cm.timestamp >= TIMESTAMPTZ '2026-09-01 16:00:00+00'
    AND cm.role = 'user'
    AND COALESCE(cm.is_self, false) = false
  GROUP BY cm.chat_id, (cm.timestamp AT TIME ZONE 'Asia/Shanghai')::date
),
recovered_tokens AS (
  SELECT
    mpr.chat_id,
    (mpr.received_at AT TIME ZONE 'Asia/Shanghai')::date AS activity_date,
    LEAST(SUM(COALESCE(mpr.token_usage, 0)), 2147483647)::integer AS token_usage
  FROM message_processing_records mpr
  WHERE mpr.received_at >= TIMESTAMPTZ '2026-09-01 16:00:00+00'
  GROUP BY mpr.chat_id, (mpr.received_at AT TIME ZONE 'Asia/Shanghai')::date
)
INSERT INTO user_activity (
  chat_id,
  activity_date,
  od_id,
  od_name,
  message_count,
  token_usage,
  bot_user_id,
  im_bot_id,
  first_active_at,
  last_active_at,
  updated_at
)
SELECT
  rm.chat_id,
  rm.activity_date,
  rm.od_id,
  rm.od_name,
  rm.message_count,
  COALESCE(rt.token_usage, 0),
  rm.bot_user_id,
  rm.im_bot_id,
  rm.first_active_at,
  rm.last_active_at,
  now()
FROM recovered_messages rm
LEFT JOIN recovered_tokens rt
  ON rt.chat_id = rm.chat_id
 AND rt.activity_date = rm.activity_date
ON CONFLICT (chat_id, activity_date) DO UPDATE SET
  od_id           = COALESCE(EXCLUDED.od_id, user_activity.od_id),
  od_name         = COALESCE(EXCLUDED.od_name, user_activity.od_name),
  message_count   = GREATEST(user_activity.message_count, EXCLUDED.message_count),
  token_usage     = GREATEST(user_activity.token_usage, EXCLUDED.token_usage),
  bot_user_id     = COALESCE(EXCLUDED.bot_user_id, user_activity.bot_user_id),
  im_bot_id       = COALESCE(EXCLUDED.im_bot_id, user_activity.im_bot_id),
  first_active_at = LEAST(user_activity.first_active_at, EXCLUDED.first_active_at),
  last_active_at  = GREATEST(user_activity.last_active_at, EXCLUDED.last_active_at),
  updated_at      = now();
