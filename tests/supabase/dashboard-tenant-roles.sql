-- Run after the tenant role migration. Every fixture is rolled back.
BEGIN;
DO $$
DECLARE
  leader uuid := gen_random_uuid(); manager uuid := gen_random_uuid(); invited uuid := gen_random_uuid();
  invalid_user uuid := gen_random_uuid(); member_id uuid;
  tenant text := gen_random_uuid()::text; other_tenant text := gen_random_uuid()::text;
  roster jsonb; staff jsonb; phone_prefix text := '999'||lpad((floor(random()*100000000))::bigint::text,8,'0');
BEGIN
  INSERT INTO public.tenants(id,name) VALUES (tenant,'角色验收'),(other_tenant,'调岗验收');
  staff := jsonb_build_object('name','演示成员','organization',tenant);
  -- An old client omits the role. An explicitly appointed manager can also open without a group.
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES
    (leader,phone_prefix||'1',jsonb_build_object('cake_dashboard_account',staff)),
    (manager,phone_prefix||'2',jsonb_build_object('cake_dashboard_account',staff||'{"tenant_role":"tenant_admin"}'));
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE user_id=leader AND tenant_role='group_leader')
    OR NOT EXISTS (SELECT FROM public.tenant_members WHERE user_id=manager AND tenant_role='tenant_admin' AND login_name IS NULL)
    THEN RAISE EXCEPTION 'incorrect roles for direct account opening'; END IF;

  roster := jsonb_build_array(staff||jsonb_build_object('hosting_group_id',tenant||'-group'));
  PERFORM public.import_dashboard_staff_roster(roster,false);
  SELECT id INTO STRICT member_id FROM public.tenant_members WHERE hosting_group_id=tenant||'-group';
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES (invited,phone_prefix||'3',
    jsonb_build_object('cake_dashboard_account',staff||jsonb_build_object('member_id',member_id,'tenant_role','tenant_admin')));
  PERFORM public.import_dashboard_staff_roster(roster,false);
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE id=member_id AND user_id=invited
    AND tenant_role='tenant_admin' AND hosting_group_id=tenant||'-group') THEN RAISE EXCEPTION 'pending activation or re-import lost role'; END IF;

  -- A role in the roster also survives an activation by phone from a client that omits the role.
  roster := jsonb_build_array(staff||jsonb_build_object('phone','+'||phone_prefix||'4','tenant_role','tenant_admin'));
  PERFORM public.import_dashboard_staff_roster(roster,false);
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(gen_random_uuid(),phone_prefix||'4',jsonb_build_object('cake_dashboard_account',staff));
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE phone='+'||phone_prefix||'4' AND tenant_role='tenant_admin' AND user_id IS NOT NULL)
    THEN RAISE EXCEPTION 'legacy activation erased a preassigned role'; END IF;

  BEGIN
    INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(invalid_user,phone_prefix||'5',
      jsonb_build_object('cake_dashboard_account',staff||'{"tenant_role":"system_admin"}'));
    RAISE EXCEPTION 'invalid tenant role accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS (SELECT FROM auth.users WHERE id=invalid_user) THEN RAISE EXCEPTION 'failed opening left an Auth identity'; END IF;
  UPDATE public.tenant_members SET organization=other_tenant WHERE id=member_id;
  IF NOT EXISTS (SELECT FROM public.tenant_members WHERE id=member_id AND tenant_role='group_leader' AND hosting_group_id IS NULL)
    THEN RAISE EXCEPTION 'old tenant appointment followed an organization change'; END IF;
  IF EXISTS (SELECT FROM public.tenant_members WHERE login_name='cakeadmin' AND tenant_role IS NOT NULL)
    THEN RAISE EXCEPTION 'platform identity has a tenant role'; END IF;
END $$;
ROLLBACK;
