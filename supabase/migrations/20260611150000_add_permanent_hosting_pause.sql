-- 永久禁止托管支持：user_hosting_status 增加永久标记与暂停理由
--
-- 背景：
-- 1. 现有暂停托管 3 天后自动解禁，店长微信/客户微信等联系人需要永久禁止 AI 托管；
-- 2. 候选人黑名单命中后会对该会话执行永久暂停，并把拉黑理由写入 pause_reason 供运营查看。
--
-- 永久暂停的记录 pause_expires_at 为 NULL 且 is_permanent = true，不参与自动解禁回写。

ALTER TABLE user_hosting_status
  ADD COLUMN IF NOT EXISTS is_permanent boolean NOT NULL DEFAULT false;

ALTER TABLE user_hosting_status
  ADD COLUMN IF NOT EXISTS pause_reason text;

COMMENT ON COLUMN user_hosting_status.is_permanent IS '是否永久暂停托管（true 时不自动解禁，pause_expires_at 为 NULL）';
COMMENT ON COLUMN user_hosting_status.pause_reason IS '暂停托管的理由（如候选人黑名单命中时记录拉黑理由）';
