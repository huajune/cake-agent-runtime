-- Stable member identity allows HQ to register staff before collecting their login phone.
ALTER TABLE public.dashboard_accounts ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE public.dashboard_accounts ADD COLUMN IF NOT EXISTS feishu_open_id text;
ALTER TABLE public.dashboard_accounts ADD COLUMN IF NOT EXISTS login_name text;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_accounts_phone_key ON public.dashboard_accounts (phone);
DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_constraint WHERE conrelid='public.dashboard_accounts'::regclass
    AND contype='p' AND pg_get_constraintdef(oid)='PRIMARY KEY (phone)') THEN
    ALTER TABLE public.dashboard_accounts DROP CONSTRAINT dashboard_accounts_pkey;
    ALTER TABLE public.dashboard_accounts ADD PRIMARY KEY (id);
  END IF;
END $$;
ALTER TABLE public.dashboard_accounts ALTER COLUMN phone DROP NOT NULL;
ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_accounts_organization_check;
ALTER TABLE public.dashboard_accounts ADD CONSTRAINT dashboard_accounts_organization_check
  CHECK (organization IN ('headquarters', 'henan', 'shanghai_recruitment'));
ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_login_requires_phone;
ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_login_identity;
ALTER TABLE public.dashboard_accounts ADD CONSTRAINT dashboard_login_identity CHECK (
  (login_name IS NULL AND (phone IS NOT NULL OR (user_id IS NULL AND
    (hosting_group_id IS NOT NULL OR feishu_open_id IS NOT NULL))))
  OR (login_name IS NOT NULL AND login_name='cakeadmin' AND user_id IS NOT NULL
    AND organization='headquarters' AND phone IS NULL AND hosting_group_id IS NULL AND feishu_open_id IS NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_accounts_login_name ON public.dashboard_accounts(login_name)
  WHERE login_name IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dashboard_accounts_feishu_identity ON public.dashboard_accounts(feishu_open_id)
  WHERE feishu_open_id IS NOT NULL;

-- The same validation runs before deployment and inside the transaction that imports all profiles.
CREATE OR REPLACE FUNCTION public.import_dashboard_staff_roster(members jsonb, validate_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE m record; a public.dashboard_accounts%ROWTYPE;
BEGIN
  IF NOT validate_only THEN LOCK TABLE public.dashboard_accounts IN SHARE ROW EXCLUSIVE MODE; END IF;
  FOR m IN SELECT * FROM jsonb_to_recordset(members)
    AS x(name text, phone text, organization text, hosting_group_id text, feishu_open_id text)
  LOOP
    IF m.name IS NULL OR btrim(m.name) = '' OR m.organization IS NULL
      OR m.organization NOT IN ('henan','shanghai_recruitment','headquarters')
      OR (m.phone IS NOT NULL AND m.phone !~ '^\+[1-9][0-9]{7,14}$')
      OR num_nonnulls(m.phone, m.hosting_group_id, m.feishu_open_id) = 0 THEN
      RAISE EXCEPTION 'Invalid staff identity' USING ERRCODE='23514';
    END IF;
    BEGIN
      SELECT * INTO STRICT a FROM public.dashboard_accounts
        WHERE phone=m.phone OR feishu_open_id=m.feishu_open_id OR hosting_group_id=m.hosting_group_id;
    EXCEPTION WHEN no_data_found THEN
      IF NOT validate_only THEN
        INSERT INTO public.dashboard_accounts(name,phone,organization,hosting_group_id,feishu_open_id)
        VALUES(m.name,m.phone,m.organization,m.hosting_group_id,m.feishu_open_id);
      END IF;
      CONTINUE;
    END;
    IF a.name <> m.name OR a.organization <> m.organization
      OR (a.phone IS NOT NULL AND a.phone <> m.phone)
      OR (a.hosting_group_id IS NOT NULL AND a.hosting_group_id <> m.hosting_group_id)
      OR (a.feishu_open_id IS NOT NULL AND a.feishu_open_id <> m.feishu_open_id) THEN
      RAISE EXCEPTION 'Staff identity conflicts with an existing account' USING ERRCODE='23514';
    END IF;
    IF NOT validate_only AND NOT a.disabled THEN
      UPDATE public.dashboard_accounts SET phone=coalesce(a.phone,m.phone),
        hosting_group_id=coalesce(a.hosting_group_id,m.hosting_group_id),
        feishu_open_id=coalesce(a.feishu_open_id,m.feishu_open_id)
        WHERE id=a.id;
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.import_dashboard_staff_roster(jsonb,boolean) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.import_dashboard_staff_roster(jsonb,boolean) TO service_role;

CREATE OR REPLACE FUNCTION public.bind_dashboard_auth_user() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE profile jsonb := NEW.raw_app_meta_data -> 'cake_dashboard_account';
  login_phone text := '+' || ltrim(NEW.phone,'+');
BEGIN
  IF TG_OP='UPDATE' AND OLD.raw_app_meta_data ? 'cake_dashboard_account' THEN RETURN NEW; END IF;
  IF profile ? 'login_name' THEN
    IF profile->>'login_name' IS DISTINCT FROM 'cakeadmin'
      OR profile->>'organization' IS DISTINCT FROM 'headquarters'
      OR NEW.email IS DISTINCT FROM 'cakeadmin@dashboard.cake.invalid'
      OR nullif(NEW.phone,'') IS NOT NULL OR profile ? 'member_id' THEN
      RAISE EXCEPTION 'Invalid dedicated administrator identity' USING ERRCODE='23514';
    END IF;
    INSERT INTO public.dashboard_accounts(login_name,user_id,name,organization)
      VALUES('cakeadmin',NEW.id,'总部管理员','headquarters');
  ELSIF nullif(NEW.phone,'') IS NULL THEN
    RAISE EXCEPTION 'Staff login requires a phone' USING ERRCODE='23514';
  ELSIF profile->>'member_id' IS NOT NULL THEN
    UPDATE public.dashboard_accounts SET user_id=NEW.id, phone=login_phone
    WHERE id=(profile->>'member_id')::uuid AND user_id IS NULL AND NOT disabled
      AND (phone IS NULL OR phone=login_phone) AND organization=profile->>'organization' AND name=profile->>'name';
  ELSE
    INSERT INTO public.dashboard_accounts AS roster(phone,user_id,name,organization)
      VALUES(login_phone,NEW.id,profile->>'name',profile->>'organization')
    ON CONFLICT(phone) DO UPDATE SET user_id=EXCLUDED.user_id, name=EXCLUDED.name
      WHERE roster.user_id IS NULL AND NOT roster.disabled AND roster.organization=EXCLUDED.organization;
  END IF;
  IF NOT FOUND THEN RAISE EXCEPTION 'Dashboard account conflicts with the existing roster'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.bind_dashboard_auth_user() FROM PUBLIC, anon, authenticated;

-- The admin uses the guarded Cake API. Direct browser sessions cannot read or change the global switch.
DROP POLICY IF EXISTS dashboard_ai_reply_server_only ON public.system_config;
CREATE POLICY dashboard_ai_reply_server_only ON public.system_config AS RESTRICTIVE FOR ALL TO anon, authenticated
  USING (key <> 'ai_reply_enabled') WITH CHECK (key <> 'ai_reply_enabled');
