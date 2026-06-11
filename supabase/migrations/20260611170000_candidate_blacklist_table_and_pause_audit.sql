-- 候选人黑名单独立表 + 暂停托管审计字段
--
-- 1. candidate_blacklist 从 system_config JSON 键迁出为独立表：
--    黑名单是业务记录而非系统配置，需要操作时间/操作人/拉黑时会话快照/命中回溯等字段。
-- 2. user_hosting_status 补充 pause_operator / pause_source，记录"谁、因何路径"暂停了托管
--    （manual=运营手动 / candidate_blacklist=黑名单命中 / interview_booking=约面工具）。

-- ==================== 候选人黑名单表 ====================

CREATE TABLE IF NOT EXISTS candidate_blacklist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 候选人标识：chatId / imContactId / externalUserId 任一
  target_id text NOT NULL UNIQUE,
  -- 拉黑理由（命中告警与暂停记录中展示）
  reason text NOT NULL,
  -- 操作人
  operator text,
  -- 拉黑时的会话快照（回溯用）
  chat_id text,
  im_contact_id text,
  contact_name text,
  -- 来源：manual=运营手动 / api=外部系统
  source text NOT NULL DEFAULT 'manual',
  -- 命中回溯：哪个托管号最近一次聊到该候选人
  hit_count integer NOT NULL DEFAULT 0,
  last_hit_at timestamp with time zone,
  last_hit_chat_id text,
  last_hit_bot_id text,
  last_hit_message_id text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_candidate_blacklist_created_at
  ON candidate_blacklist (created_at DESC);

COMMENT ON TABLE candidate_blacklist IS '候选人黑名单：任一托管号再次聊到命中候选人时告警并永久取消该会话托管';
COMMENT ON COLUMN candidate_blacklist.target_id IS '候选人标识（chatId / imContactId / externalUserId 任一）';
COMMENT ON COLUMN candidate_blacklist.hit_count IS '命中次数（托管号收到该候选人消息触发拦截的累计次数）';

-- 命中回溯的原子更新（避免读-改-写竞态）
CREATE OR REPLACE FUNCTION record_candidate_blacklist_hit(
  p_target_id text,
  p_chat_id text,
  p_bot_id text,
  p_message_id text
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE candidate_blacklist
  SET hit_count = hit_count + 1,
      last_hit_at = now(),
      last_hit_chat_id = p_chat_id,
      last_hit_bot_id = p_bot_id,
      last_hit_message_id = p_message_id,
      updated_at = now()
  WHERE target_id = p_target_id;
$$;

-- 搬迁 system_config.candidate_blacklist 旧数据（如有），随后删除该键
-- 注意：先在子查询里过滤出数组行，再 LATERAL 展开，避免集合返回函数对非数组 value 求值报错
INSERT INTO candidate_blacklist (target_id, reason, operator, created_at)
SELECT
  item->>'target_id',
  coalesce(item->>'reason', ''),
  item->>'operator',
  coalesce(to_timestamp((item->>'added_at')::bigint / 1000.0), now())
FROM (
  SELECT value
  FROM system_config
  WHERE key = 'candidate_blacklist'
    AND jsonb_typeof(value) = 'array'
) src
CROSS JOIN LATERAL jsonb_array_elements(src.value) AS item
WHERE item->>'target_id' IS NOT NULL
ON CONFLICT (target_id) DO NOTHING;

DELETE FROM system_config WHERE key = 'candidate_blacklist';

-- ==================== 暂停托管审计字段 ====================

ALTER TABLE user_hosting_status
  ADD COLUMN IF NOT EXISTS pause_operator text;

ALTER TABLE user_hosting_status
  ADD COLUMN IF NOT EXISTS pause_source text;

COMMENT ON COLUMN user_hosting_status.pause_operator IS '暂停操作人（运营手动暂停时记录）';
COMMENT ON COLUMN user_hosting_status.pause_source IS '暂停来源：manual / candidate_blacklist / interview_booking 等';
