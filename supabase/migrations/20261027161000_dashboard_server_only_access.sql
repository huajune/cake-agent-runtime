-- 运营后台通过 NestJS 按来源与机器人授权；浏览器不能绕过后端直读业务表/RPC。
-- 必须和取消前端 Supabase Realtime 直连的代码一起发布。仅处理 public 中非扩展拥有的对象。
-- 本项目 public 为 Cake 业务 schema；上线前确认没有其他客户端依赖 anon/authenticated 直连。
DO $$
DECLARE obj record; col record;
BEGIN
  FOR obj IN
    SELECT c.oid, n.nspname, c.relname
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
        AND d.objid = c.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE ALL ON %s %I.%I FROM PUBLIC, anon, authenticated',
      CASE WHEN (SELECT relkind FROM pg_class WHERE oid = obj.oid) = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      obj.nspname, obj.relname);
    EXECUTE format('GRANT ALL ON %s %I.%I TO service_role',
      CASE WHEN (SELECT relkind FROM pg_class WHERE oid = obj.oid) = 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
      obj.nspname, obj.relname);
    -- 表级 REVOKE 不会清除历史列级授权。
    FOR col IN SELECT attname FROM pg_attribute
      WHERE attrelid = obj.oid AND attnum > 0 AND NOT attisdropped AND attacl IS NOT NULL
    LOOP
      EXECUTE format('REVOKE ALL (%I) ON TABLE %I.%I FROM PUBLIC, anon, authenticated',
        col.attname, obj.nspname, obj.relname);
    END LOOP;
  END LOOP;
  -- SECURITY DEFINER RPC 也必须撤销，否则只收紧表授权仍可绕过。
  FOR obj IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.prokind = 'f'
      AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_proc'::regclass
        AND d.objid = p.oid AND d.deptype = 'e')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated', obj.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', obj.signature);
  END LOOP;
END $$;

ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO service_role;
