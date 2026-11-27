-- A tenant role describes an employee's position. Platform administration stays with the dedicated login.
ALTER TABLE public.dashboard_accounts ADD COLUMN IF NOT EXISTS tenant_role text DEFAULT 'group_leader';
UPDATE public.dashboard_accounts SET tenant_role=NULL WHERE login_name IS NOT NULL AND tenant_role IS NOT NULL;
ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_accounts_tenant_role_check;
ALTER TABLE public.dashboard_accounts ADD CONSTRAINT dashboard_accounts_tenant_role_check CHECK (
  (login_name IS NULL AND tenant_role IS NOT NULL AND tenant_role IN ('group_leader','tenant_admin')) OR
  (login_name IS NOT NULL AND tenant_role IS NULL)
);

-- Auth identity, employee role and any selected hosting group commit in the same transaction.
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
    INSERT INTO public.dashboard_accounts(login_name,user_id,name,organization,tenant_role)
      VALUES('cakeadmin',NEW.id,'总部管理员','headquarters',NULL);
  ELSIF nullif(NEW.phone,'') IS NULL THEN
    RAISE EXCEPTION 'Staff login requires a phone' USING ERRCODE='23514';
  ELSIF profile->>'member_id' IS NOT NULL THEN
    UPDATE public.dashboard_accounts SET user_id=NEW.id, phone=login_phone,
      tenant_role=coalesce(requested_role, tenant_role)
    WHERE id=(profile->>'member_id')::uuid AND user_id IS NULL AND NOT disabled
      AND (phone IS NULL OR phone=login_phone) AND organization=profile->>'organization' AND name=profile->>'name';
  ELSE
    INSERT INTO public.dashboard_accounts AS roster(phone,user_id,name,organization,tenant_role)
      VALUES(login_phone,NEW.id,profile->>'name',profile->>'organization',coalesce(requested_role,'group_leader'))
    ON CONFLICT(phone) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name,
      tenant_role=coalesce(requested_role,roster.tenant_role)
      WHERE roster.user_id IS NULL AND NOT roster.disabled AND roster.organization=EXCLUDED.organization;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard account conflicts with the existing roster'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bind_dashboard_auth_user() FROM PUBLIC, anon, authenticated;

-- Re-importing a roleless roster preserves the recorded role. Active accounts cannot be reassigned by import.
CREATE OR REPLACE FUNCTION public.import_dashboard_staff_roster(members jsonb, validate_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE m record; a public.dashboard_accounts%ROWTYPE;
BEGIN
  IF NOT validate_only THEN LOCK TABLE public.dashboard_accounts IN SHARE ROW EXCLUSIVE MODE; END IF;
  FOR m IN SELECT * FROM jsonb_to_recordset(members)
    AS x(name text, phone text, organization text, tenant_role text, hosting_group_id text, feishu_open_id text)
  LOOP
    IF m.name IS NULL OR btrim(m.name) = '' OR m.organization IS NULL
      OR (m.tenant_role IS NOT NULL AND m.tenant_role NOT IN ('tenant_admin','group_leader'))
      OR NOT EXISTS (SELECT FROM public.tenants WHERE id=m.organization)
      OR (m.phone IS NOT NULL AND m.phone !~ '^\+[1-9][0-9]{7,14}$')
      OR num_nonnulls(m.phone, m.hosting_group_id, m.feishu_open_id) = 0 THEN
      RAISE EXCEPTION 'Invalid staff identity' USING ERRCODE='23514';
    END IF;
    BEGIN
      SELECT * INTO STRICT a FROM public.dashboard_accounts
        WHERE phone=m.phone OR feishu_open_id=m.feishu_open_id OR hosting_group_id=m.hosting_group_id;
    EXCEPTION WHEN no_data_found THEN
      IF NOT validate_only THEN
        INSERT INTO public.dashboard_accounts(name,phone,organization,tenant_role,hosting_group_id,feishu_open_id)
        VALUES(m.name,m.phone,m.organization,coalesce(m.tenant_role,'group_leader'),m.hosting_group_id,m.feishu_open_id);
      END IF;
      CONTINUE;
    END;
    IF a.name <> m.name OR a.organization <> m.organization
      OR (a.user_id IS NOT NULL AND NOT a.disabled AND m.tenant_role IS NOT NULL AND m.tenant_role <> a.tenant_role)
      OR (a.phone IS NOT NULL AND a.phone <> m.phone)
      OR (a.hosting_group_id IS NOT NULL AND a.hosting_group_id <> m.hosting_group_id)
      OR (a.feishu_open_id IS NOT NULL AND a.feishu_open_id <> m.feishu_open_id) THEN
      RAISE EXCEPTION 'Staff identity conflicts with an existing account' USING ERRCODE='23514';
    END IF;
    IF NOT validate_only AND NOT a.disabled THEN
      UPDATE public.dashboard_accounts SET phone=coalesce(a.phone,m.phone),
        tenant_role=CASE WHEN a.user_id IS NULL THEN coalesce(m.tenant_role,a.tenant_role) ELSE a.tenant_role END,
        hosting_group_id=coalesce(a.hosting_group_id,m.hosting_group_id),
        feishu_open_id=coalesce(a.feishu_open_id,m.feishu_open_id)
        WHERE id=a.id;
    END IF;
  END LOOP;
END $$;

-- An appointment as administrator is specific to the original tenant.
CREATE OR REPLACE FUNCTION public.clear_transferred_dashboard_group() RETURNS trigger
LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  NEW.hosting_group_id := NULL;
  NEW.tenant_role := 'group_leader';
  RETURN NEW;
END $$;
