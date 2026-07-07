-- 收紧复聊触达追溯表权限：
-- reengagement_touch_records 含 session/user/corp 标识、生成文案、错误与事件轨迹，
-- 只能通过后端 service_role 查询，不对 anon/authenticated 直接开放。

DROP POLICY IF EXISTS "Allow public read" ON public.reengagement_touch_records;

REVOKE SELECT ON TABLE public.reengagement_touch_records FROM anon, authenticated, PUBLIC;
GRANT SELECT ON TABLE public.reengagement_touch_records TO service_role;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'reengagement_touch_records'
       AND policyname = 'Service role read'
  ) THEN
    CREATE POLICY "Service role read"
      ON public.reengagement_touch_records
      AS PERMISSIVE
      FOR SELECT
      TO public
      USING ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END $$;

-- RPC 也只给 service_role 调用；前端统一走 Nest API。
-- record_reengagement_touch 后续可能扩展参数，这里按函数名收紧所有重载，避免签名漂移。
DO $$
DECLARE
  fn REGPROCEDURE;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN (
         'record_reengagement_touch',
         'get_reengagement_touch_stats',
         'get_reengagement_candidate_overview'
       )
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
