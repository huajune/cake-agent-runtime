-- 候选人黑名单：托管账号快照 + 命中时回填候选人昵称
--
-- 1. 新增拉黑时的托管账号快照列（im_bot_id / bot_name）：
--    黑名单是全局拦截（任一托管号命中），此处记录拉黑时该候选人
--    最近聊过的托管账号，供 Dashboard 展示候选人昵称与所在托管号。
-- 2. record_candidate_blacklist_hit 增加 p_contact_name 参数：
--    拉黑时未能解析到昵称/托管号的记录（如外部系统只传了 ID），
--    在首次命中时用回调里的客户名称与托管号 wxid 回填快照（不覆盖已有值）。

ALTER TABLE candidate_blacklist ADD COLUMN IF NOT EXISTS im_bot_id text;
ALTER TABLE candidate_blacklist ADD COLUMN IF NOT EXISTS bot_name text;

COMMENT ON COLUMN candidate_blacklist.im_bot_id IS '拉黑时快照：该候选人最近聊过的托管账号 wxid';
COMMENT ON COLUMN candidate_blacklist.bot_name IS '拉黑时快照：该托管账号的招募经理姓名';

-- 函数签名变化（新增参数）：先删旧的四参版本，避免 PostgREST 出现重载歧义
DROP FUNCTION IF EXISTS record_candidate_blacklist_hit(text, text, text, text);

CREATE OR REPLACE FUNCTION record_candidate_blacklist_hit(
  p_target_id text,
  p_chat_id text,
  p_bot_id text,
  p_message_id text,
  p_contact_name text DEFAULT NULL
) RETURNS void
LANGUAGE sql
AS $$
  UPDATE candidate_blacklist
  SET hit_count = hit_count + 1,
      last_hit_at = now(),
      last_hit_chat_id = p_chat_id,
      last_hit_bot_id = p_bot_id,
      last_hit_message_id = p_message_id,
      -- 拉黑时缺失的快照用命中消息回填，已有值不覆盖
      contact_name = COALESCE(contact_name, p_contact_name),
      im_bot_id = COALESCE(im_bot_id, p_bot_id),
      chat_id = COALESCE(chat_id, p_chat_id),
      updated_at = now()
  WHERE target_id = p_target_id;
$$;
