BEGIN;
DO $$
DECLARE
  conn text := 'qa-group-switch-' || gen_random_uuid();
  grp text := 'qa-group-' || gen_random_uuid();
  items jsonb;
BEGIN
  IF has_function_privilege('authenticated', 'public.set_tenant_hosting_group_blacklisted(text,text,text,boolean,text)', 'EXECUTE')
    OR has_function_privilege('anon', 'public.set_tenant_hosting_group_blacklisted(text,text,text,boolean,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Tenant group switch must be server-only';
  END IF;
  INSERT INTO public.hosting_group_ownership VALUES (conn, grp, clock_timestamp(), 'headquarters');
  items := public.set_tenant_hosting_group_blacklisted(conn, 'headquarters', grp, true, 'QA');
  IF NOT items @> jsonb_build_array(jsonb_build_object('group_id', grp)) THEN
    RAISE EXCEPTION 'Owned group did not pause';
  END IF;
  BEGIN
    PERFORM public.set_tenant_hosting_group_blacklisted(conn, 'henan', grp, false, 'QA');
    RAISE EXCEPTION 'Another organization altered group hosting';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF NOT (SELECT value @> jsonb_build_array(jsonb_build_object('group_id', grp))
          FROM public.system_config WHERE key = 'group_blacklist') THEN
    RAISE EXCEPTION 'A rejected operation changed the hosting state';
  END IF;
  items := public.set_tenant_hosting_group_blacklisted(conn, 'headquarters', grp, false, 'QA');
  IF items @> jsonb_build_array(jsonb_build_object('group_id', grp)) THEN
    RAISE EXCEPTION 'The owning organization could not resume hosting';
  END IF;
END;
$$;
ROLLBACK;
