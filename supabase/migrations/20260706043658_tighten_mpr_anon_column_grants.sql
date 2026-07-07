-- 收紧 message_processing_records 的 anon/authenticated 列级读权限
--
-- 背景：表上的 RLS 策略 "Allow public read" USING(true) + Supabase 默认全列 GRANT，
-- 意味着任何拿到 anon key 的人可经 PostgREST 读整张表——而 anon key 打包在
-- 公开伺服的 dashboard 前端产物里（public/web/assets/）。本表的 message_preview /
-- reply_preview 含候选人对话原文（姓名/手机号），agent_invocation 含完整提示词。
--
-- 为什么不直接删 RLS 读策略：dashboard 的 realtime 订阅
-- （web/src/hooks/chat/useRealtimeMessageProcessing.ts）依赖 anon 的行可见性
-- 才能收到 postgres_changes 事件；但其回调不消费 payload（纯刷新信号）。
-- Realtime(WALRUS) 按 has_column_privilege 裁剪 payload 列，因此：
--   保留行策略 + 收紧列 GRANT = realtime 刷新信号照常，PII 列不再可读。
--
-- 数据读取本身全部走后端 API（service_role，不受本变更影响）。

REVOKE SELECT ON message_processing_records FROM anon;
REVOKE SELECT ON message_processing_records FROM authenticated;

-- 仅保留无害的标识/状态列（realtime payload 及未来轻量订阅可用）
GRANT SELECT (id, chat_id, status, received_at, updated_at)
  ON message_processing_records TO anon;
GRANT SELECT (id, chat_id, status, received_at, updated_at)
  ON message_processing_records TO authenticated;
