-- 收紧 message_processing_invocations 的 Data API 访问权限。
--
-- 该表保存完整 Agent 请求/响应快照，只由后端 service_role 读写。建表迁移遗漏了
-- RLS；在仍沿用 public schema 默认授权的项目中，anon/authenticated 会因此能够
-- 通过 PostgREST 访问整表。

ALTER TABLE public.message_processing_invocations
  ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES
  ON TABLE public.message_processing_invocations
  FROM PUBLIC, anon, authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE
  ON TABLE public.message_processing_invocations
  TO service_role;

DROP POLICY IF EXISTS "Service role full access on message_processing_invocations"
  ON public.message_processing_invocations;

CREATE POLICY "Service role full access on message_processing_invocations"
  ON public.message_processing_invocations
  AS PERMISSIVE
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
