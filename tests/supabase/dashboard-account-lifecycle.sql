-- Exercises real constraints and Auth triggers. All fixtures are rolled back.
BEGIN;
DO $$
DECLARE
  org text := gen_random_uuid()::text; other_org text := gen_random_uuid()::text;
  employee uuid := gen_random_uuid(); replacement uuid := gen_random_uuid(); member_id uuid;
  session_id uuid := gen_random_uuid();
  login_phone text := '999' || lpad(floor(random()*1e10)::bigint::text,10,'0');
  profile jsonb := jsonb_build_object('cake_dashboard_account', jsonb_build_object('name','测试员工','organization',org));
BEGIN
  IF has_function_privilege('authenticated','public.delete_empty_tenant(text)','EXECUTE')
     OR has_function_privilege('anon','public.delete_disabled_dashboard_login(uuid)','EXECUTE')
     OR has_function_privilege('anon','public.delete_empty_tenant(text)','EXECUTE')
     OR has_function_privilege('authenticated','public.delete_disabled_dashboard_login(uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'Browser roles can invoke privileged operations';
  END IF;
  INSERT INTO public.tenants(id,name) VALUES (org,'测试组织'),(other_org,'测试组织');
  IF NOT public.delete_empty_tenant(other_org) THEN RAISE EXCEPTION 'Empty organization removal failed'; END IF;
  IF public.delete_empty_tenant(other_org) THEN RAISE EXCEPTION 'Deleted a missing organization'; END IF;
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES (employee,login_phone,profile);
  UPDATE public.tenant_members SET hosting_group_id=org WHERE user_id=employee RETURNING id INTO STRICT member_id;
  IF has_function_privilege('anon','public.current_dashboard_account()','EXECUTE')
     OR NOT has_function_privilege('authenticated','public.current_dashboard_account()','EXECUTE') THEN
    RAISE EXCEPTION 'Unexpected permissions on account lookup'; END IF;
  INSERT INTO auth.sessions(id,user_id,created_at,updated_at) VALUES (session_id,employee,now(),now());
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',employee,'session_id',session_id)::text,true);
  IF public.current_dashboard_account() IS NOT NULL THEN RAISE EXCEPTION 'Unconfirmed phone accepted'; END IF;
  UPDATE auth.users SET phone_confirmed_at=now() WHERE id=employee;
  IF public.current_dashboard_account()->>'memberId' IS DISTINCT FROM member_id::text OR
     public.current_dashboard_account()->>'organization' IS DISTINCT FROM org THEN RAISE EXCEPTION 'Active member missing'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',replacement,'session_id',session_id)::text,true);
  IF public.current_dashboard_account() IS NOT NULL THEN RAISE EXCEPTION 'Mismatched session owner'; END IF;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',employee,'session_id',session_id)::text,true);
  UPDATE auth.sessions SET not_after=now()-interval '1 minute' WHERE id=session_id;
  IF public.current_dashboard_account() IS NOT NULL THEN RAISE EXCEPTION 'Expired session accepted'; END IF;
  UPDATE auth.sessions SET not_after=NULL WHERE id=session_id;
  BEGIN
    PERFORM public.delete_disabled_dashboard_login(employee);
    RAISE EXCEPTION 'Removed an active login';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM public.delete_empty_tenant(org);
    RAISE EXCEPTION 'Removed an organization with members';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE auth.users SET banned_until = now()+interval '100 years' WHERE id=employee;
  IF public.current_dashboard_account() IS NOT NULL THEN RAISE EXCEPTION 'Banned user accepted'; END IF;
  UPDATE auth.users SET banned_until = NULL WHERE id=employee;
  IF (SELECT disabled FROM public.tenant_members WHERE id=member_id) THEN RAISE EXCEPTION 'Restore failed'; END IF;
  UPDATE auth.users SET banned_until = now()+interval '100 years' WHERE id=employee;
  IF NOT public.delete_disabled_dashboard_login(employee) THEN RAISE EXCEPTION 'Login removal failed'; END IF;
  IF EXISTS(SELECT FROM auth.users WHERE id=employee) THEN RAISE EXCEPTION 'Login was not removed'; END IF;
  IF public.current_dashboard_account() IS NOT NULL THEN RAISE EXCEPTION 'Deleted login accepted'; END IF;
  IF NOT EXISTS(SELECT FROM public.tenant_members WHERE id=member_id AND user_id IS NULL AND disabled
    AND organization=org AND phone='+'||login_phone AND name='测试员工' AND hosting_group_id=org) THEN
    RAISE EXCEPTION 'Cancelled member or group was lost';
  END IF;
  BEGIN
    INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES (replacement,login_phone,profile);
  EXCEPTION WHEN raise_exception THEN NULL; END;
  IF EXISTS(SELECT FROM auth.users WHERE id=replacement) THEN
    RAISE EXCEPTION 'Batch provisioning silently re-registered a cancelled login'; END IF;
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES
    (replacement,login_phone,jsonb_set(profile,'{cake_dashboard_account,member_id}',to_jsonb(member_id)));
  IF NOT EXISTS(SELECT FROM public.tenant_members WHERE id=member_id AND user_id=replacement AND NOT disabled AND hosting_group_id=org) THEN
    RAISE EXCEPTION 'Reopening did not bind the same member and group';
  END IF;
  INSERT INTO public.tenants(id,name) VALUES (other_org,'空账号组织');
  INSERT INTO public.hosting_group_ownership(connection_id,group_id,effective_from,tenant_id)
    VALUES ('lifecycle-test',other_org,now(),other_org);
  BEGIN
    PERFORM public.delete_empty_tenant(other_org);
    RAISE EXCEPTION 'Removed an organization with a hosting group';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  other_org := gen_random_uuid()::text;
  INSERT INTO public.tenants(id,name) VALUES (other_org,'历史业务组织');
  INSERT INTO public.user_activity_events(event_key,chat_id,occurred_at,tenant_id,message_count,token_usage)
    VALUES (other_org,other_org,now(),other_org,1,0);
  BEGIN
    PERFORM public.delete_empty_tenant(other_org);
    RAISE EXCEPTION 'Removed an organization with historical business records';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
END $$;
ROLLBACK;
