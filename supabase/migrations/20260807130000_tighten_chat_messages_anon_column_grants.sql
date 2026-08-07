-- 收紧 chat_messages 的 anon/authenticated 列级读权限
--
-- 背景：表上的 RLS 策略 "Allow public read" USING(true) 配合默认全列 GRANT，
-- 会让公开在 dashboard 前端中的 publishable/legacy anon key 通过 PostgREST
-- 读取 content、candidate_name、payload、visual_facts 等候选人敏感数据。
--
-- 为什么保留 RLS 读策略：dashboard 的 Realtime 订阅
-- （web/src/hooks/chat/useRealtimeChatRecords.ts）需要 anon 具备行可见性，
-- 但回调只读取 chat_id 以刷新后端 API 缓存。Realtime 会按列权限裁剪 payload，
-- 因此保留最小标识列即可维持实时刷新，同时阻止匿名读取消息正文与身份字段。
--
-- 业务数据查询均通过后端 service_role 完成，不受本变更影响。

REVOKE SELECT ON public.chat_messages FROM anon;
REVOKE SELECT ON public.chat_messages FROM authenticated;

GRANT SELECT (id, chat_id)
  ON public.chat_messages TO anon;
GRANT SELECT (id, chat_id)
  ON public.chat_messages TO authenticated;
