-- 候选人消息「只存历史、未交给 Agent」的原因。
-- 托管暂停、候选人黑名单、小组未托管时，候选人消息由真人处理，不会产生 message_processing_records；
-- 复聊待答闸据此区分「转给真人处理」与「主链静默丢消息」，报名前场景据此把转真人的回话算作已回话。
-- PG 加可空无默认值列为元数据级 DDL，不重写表；不回填历史（NULL = 已交给 Agent、非候选人消息或旧数据）。
-- anon/authenticated 只有 (id, chat_id) 列级读权限，新列不对前端匿名 key 暴露。

BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.chat_messages ADD COLUMN IF NOT EXISTS history_only_reason text;

COMMENT ON COLUMN public.chat_messages.history_only_reason IS
  '候选人消息只存历史、未交给 Agent 的原因（FilterReason）：user-paused=托管暂停/candidate-blacklisted=候选人黑名单/group-blacklisted=小组未托管。NULL=已交给 Agent、非候选人消息或旧数据。';

COMMIT;
