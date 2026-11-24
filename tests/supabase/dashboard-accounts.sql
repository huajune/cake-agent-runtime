-- Run on an isolated database with Supabase auth.users, anon and authenticated roles.
BEGIN;
DO $$
DECLARE
  h uuid := gen_random_uuid();
  c uuid := gen_random_uuid();
  u uuid := gen_random_uuid();
BEGIN
  IF to_regclass('public.dashboard_accounts') IS NOT NULL OR
     NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.tenant_members'::regclass) OR
     has_table_privilege('anon','public.tenant_members','SELECT') OR
     has_table_privilege('authenticated','public.tenant_members','UPDATE') OR
     has_function_privilege('authenticated','public.bind_dashboard_auth_user()','EXECUTE') OR
     has_function_privilege('anon','public.import_dashboard_henan_roster(jsonb)','EXECUTE') OR
     has_function_privilege('authenticated','public.import_dashboard_henan_roster(jsonb)','EXECUTE')
  THEN RAISE EXCEPTION 'private staff grants'; END IF;

  INSERT INTO public.tenant_members (phone, name, organization) VALUES ('+12025550117','Fixture center','henan');
  PERFORM public.import_dashboard_henan_roster('[{"phone":"+12025550117","name":"Fixture center","hosting_group_id":"test-group"}]');
  BEGIN
    PERFORM public.import_dashboard_henan_roster('[{"phone":"+12025550120","name":"Other","hosting_group_id":"free-group"},{"phone":"+12025550121","name":"Duplicate owner","hosting_group_id":"test-group"}]');
    RAISE EXCEPTION 'two owners claimed the same Stride group';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  IF EXISTS (SELECT FROM public.tenant_members WHERE phone='+12025550120') THEN RAISE EXCEPTION 'partial roster import'; END IF;
  INSERT INTO auth.users(id, phone, raw_app_meta_data, raw_user_meta_data) VALUES
    (u,'12025550118','{}','{"cake_dashboard_account":{"name":"Fixture","organization":"headquarters"}}');
  IF EXISTS (SELECT FROM public.tenant_members WHERE user_id=u) THEN RAISE EXCEPTION 'unprovisioned user'; END IF;

  -- GoTrue creates the Auth row, then applies admin app metadata in the same transaction.
  INSERT INTO auth.users(id, phone, raw_app_meta_data) VALUES (c,'12025550117','{"provider":"phone"}');
  UPDATE auth.users SET raw_app_meta_data='{"cake_dashboard_account":{"name":"Fixture center","organization":"henan"}}' WHERE id=c;
  INSERT INTO auth.users(id, phone, raw_app_meta_data) VALUES
    (h,'12025550119','{"cake_dashboard_account":{"name":"Fixture HQ","organization":"headquarters"}}');
  IF (SELECT count(*) FROM public.tenant_members WHERE user_id IN (h,c) AND NOT disabled) <> 2
  THEN RAISE EXCEPTION 'missing account binding'; END IF;
  PERFORM public.import_dashboard_henan_roster('[{"phone":"+12025550117","name":"Fixture center","hosting_group_id":"test-group"}]');
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE user_id=c AND hosting_group_id='test-group')
  THEN RAISE EXCEPTION 'lost owner when claiming a pending login'; END IF;
  UPDATE public.tenant_members SET organization='headquarters' WHERE user_id=c;
  IF EXISTS (SELECT FROM public.tenant_members WHERE user_id=c AND hosting_group_id IS NOT NULL)
  THEN RAISE EXCEPTION 'transferred account kept its old group'; END IF;
  UPDATE public.tenant_members SET organization='henan' WHERE user_id=c;
  BEGIN
    UPDATE auth.users SET banned_until=now()+interval '100 years' WHERE id=h;
    RAISE EXCEPTION 'last headquarters account was disabled';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE auth.users SET banned_until=now()+interval '100 years' WHERE id=c;
  IF NOT (SELECT disabled FROM public.tenant_members WHERE user_id=c) THEN RAISE EXCEPTION 'ban not synchronized'; END IF;
  UPDATE auth.users SET raw_app_meta_data=raw_app_meta_data || '{"provider":"phone"}' WHERE id=c;
  IF NOT (SELECT disabled FROM public.tenant_members WHERE user_id=c) THEN RAISE EXCEPTION 'disabled account reactivated'; END IF;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE admin_id uuid := gen_random_uuid(); other_id uuid := gen_random_uuid();
  metadata jsonb := '{"cake_dashboard_account":{"login_name":"cakeadmin","organization":"headquarters"}}';
BEGIN
  INSERT INTO auth.users(id,email,raw_app_meta_data,raw_user_meta_data)
    VALUES(other_id,'other@example.invalid','{}',metadata);
  IF EXISTS (SELECT FROM public.tenant_members WHERE user_id=other_id) THEN
    RAISE EXCEPTION 'User-supplied metadata granted an administrator'; END IF;
  BEGIN
    UPDATE auth.users SET raw_app_meta_data=metadata WHERE id=other_id;
    RAISE EXCEPTION 'Wrong Auth identity bound as administrator';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO auth.users(id,email,raw_app_meta_data)
    VALUES(admin_id,'cakeadmin@dashboard.cake.invalid',metadata);
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE user_id=admin_id AND login_name='cakeadmin'
      AND phone IS NULL AND hosting_group_id IS NULL AND organization='headquarters') THEN
    RAISE EXCEPTION 'Missing dedicated administrator'; END IF;
  BEGIN
    UPDATE public.tenant_members SET hosting_group_id='fixture-group' WHERE user_id=admin_id;
    RAISE EXCEPTION 'Dedicated administrator claimed a staff group';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;

BEGIN;
DO $$
DECLARE p uuid; uid uuid := gen_random_uuid();
  members jsonb := '[{"name":"QA Shanghai","phone":null,"organization":"shanghai_recruitment","hosting_group_id":"qa-sh","feishu_open_id":"qa-open"}]';
BEGIN
  IF has_function_privilege('authenticated','public.import_dashboard_staff_roster(jsonb,boolean)','EXECUTE')
    OR has_function_privilege('anon','public.import_dashboard_staff_roster(jsonb,boolean)','EXECUTE')
    THEN RAISE EXCEPTION 'roster write privileges'; END IF;
  PERFORM public.import_dashboard_staff_roster(members,true);
  IF EXISTS (SELECT FROM public.tenant_members WHERE feishu_open_id='qa-open') THEN RAISE EXCEPTION 'preflight wrote a row'; END IF;
  PERFORM public.import_dashboard_staff_roster(members,false);
  SELECT id INTO STRICT p FROM public.tenant_members WHERE feishu_open_id='qa-open' AND phone IS NULL AND user_id IS NULL;
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(uid,'12025550168',
    jsonb_build_object('cake_dashboard_account',jsonb_build_object('member_id',p,'organization','shanghai_recruitment','name','QA Shanghai')));
  PERFORM public.import_dashboard_staff_roster(members,false);
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE id=p AND user_id=uid AND phone='+12025550168' AND hosting_group_id='qa-sh')
    THEN RAISE EXCEPTION 'opening a pending member lost the original identity'; END IF;
  BEGIN
    PERFORM public.import_dashboard_staff_roster(jsonb_set(members,'{0,organization}','"headquarters"'),false);
    RAISE EXCEPTION 'conflicting organization accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
ROLLBACK;
