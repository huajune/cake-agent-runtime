CREATE OR REPLACE FUNCTION public.bind_dashboard_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE profile jsonb := NEW.raw_app_meta_data -> 'cake_dashboard_account';
  requested_role text := profile->>'tenant_role';
  login_phone text := '+' || ltrim(NEW.phone,'+');
BEGIN
  IF TG_OP='UPDATE' AND OLD.raw_app_meta_data ? 'cake_dashboard_account' THEN RETURN NEW; END IF;
  IF profile ? 'tenant_role' AND requested_role IS NULL THEN
    RAISE EXCEPTION 'Invalid tenant role' USING ERRCODE='23514';
  END IF;
  IF profile ? 'login_name' THEN
    IF profile->>'login_name' IS DISTINCT FROM 'cakeadmin'
      OR profile->>'organization' IS DISTINCT FROM 'headquarters'
      OR NEW.email IS DISTINCT FROM 'cakeadmin@dashboard.cake.invalid'
      OR nullif(NEW.phone,'') IS NOT NULL OR profile ? 'member_id' OR profile ? 'tenant_role' THEN
      RAISE EXCEPTION 'Invalid dedicated administrator identity' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.tenant_members(login_name,user_id,name,organization,tenant_role)
      VALUES('cakeadmin',NEW.id,'cakeAdmin','headquarters',NULL);
  ELSIF nullif(NEW.phone,'') IS NULL THEN
    RAISE EXCEPTION 'Staff login requires a phone' USING ERRCODE='23514';
  ELSIF profile->>'member_id' IS NOT NULL THEN
    -- A new registration can reuse a cancelled profile only when the administrator
    -- explicitly identifies the member. Batch provisioning never reopens it.
    UPDATE public.tenant_members SET user_id=NEW.id, phone=login_phone, disabled=false,
      tenant_role=coalesce(requested_role, tenant_role)
    WHERE id=(profile->>'member_id')::uuid AND user_id IS NULL
      AND (NOT disabled OR (phone=login_phone AND NOT (profile ? 'initialization_id')))
      AND (phone IS NULL OR phone=login_phone) AND organization=profile->>'organization' AND name=profile->>'name';
  ELSE
    INSERT INTO public.tenant_members AS roster(phone,user_id,name,organization,tenant_role)
      VALUES(login_phone,NEW.id,profile->>'name',profile->>'organization',coalesce(requested_role,'group_leader'))
    ON CONFLICT(phone) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name,
      tenant_role=coalesce(requested_role,roster.tenant_role)
      WHERE roster.user_id IS NULL AND NOT roster.disabled AND roster.organization=EXCLUDED.organization;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard account conflicts with the existing roster'; END IF;
  RETURN NEW;
END $$;

UPDATE public.tenant_members
SET name = 'cakeAdmin'
WHERE login_name = 'cakeadmin' AND organization = 'headquarters' AND name IS DISTINCT FROM 'cakeAdmin';

CREATE OR REPLACE FUNCTION public.delete_disabled_dashboard_login(p_user_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE member public.tenant_members%ROWTYPE;
BEGIN
  -- Same lock order as the Auth ban/unban trigger. A racing restore or delete
  -- either sees the committed change or completes before we check the status.
  PERFORM 1 FROM auth.users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO member FROM public.tenant_members WHERE user_id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  IF NOT member.disabled OR member.login_name IS NOT NULL THEN
    RAISE EXCEPTION 'Only disabled employee logins may be removed' USING ERRCODE = '23514';
  END IF;
  UPDATE public.tenant_members SET user_id = NULL WHERE id = member.id;
  DELETE FROM auth.users WHERE id = p_user_id;
  RETURN true;
END $$;
