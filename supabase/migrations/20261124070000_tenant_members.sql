-- Member profiles can exist before a Supabase Auth identity is provisioned.
-- A PostgreSQL rename preserves the table OID, rows, grants, RLS and trigger attachments.
ALTER TABLE public.dashboard_accounts RENAME TO tenant_members;

ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_pkey TO tenant_members_pkey;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_user_id_key TO tenant_members_user_id_key;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_user_id_fkey TO tenant_members_user_id_fkey;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_tenant_fk TO tenant_members_tenant_fk;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_hosting_group_id_check TO tenant_members_hosting_group_id_check;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_phone_check TO tenant_members_phone_check;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_name_check TO tenant_members_name_check;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_accounts_tenant_role_check TO tenant_members_tenant_role_check;
ALTER TABLE public.tenant_members RENAME CONSTRAINT dashboard_login_identity TO tenant_members_login_identity;

ALTER INDEX public.dashboard_accounts_phone_key RENAME TO tenant_members_phone_key;
ALTER INDEX public.dashboard_accounts_login_name RENAME TO tenant_members_login_name;
ALTER INDEX public.dashboard_accounts_feishu_identity RENAME TO tenant_members_feishu_identity;
ALTER INDEX public.dashboard_accounts_hosting_group_owner RENAME TO tenant_members_hosting_group_owner;

COMMENT ON TABLE public.tenant_members IS '租户成员档案。成员可先建档，开通登录后关联 Supabase Auth 用户。';

-- PostgreSQL resolves these SQL and PL/pgSQL bodies by name at execution time.
-- CREATE OR REPLACE keeps each existing RPC signature, trigger attachment and grant.

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
      VALUES('cakeadmin',NEW.id,'总部管理员','headquarters',NULL);
  ELSIF nullif(NEW.phone,'') IS NULL THEN
    RAISE EXCEPTION 'Staff login requires a phone' USING ERRCODE='23514';
  ELSIF profile->>'member_id' IS NOT NULL THEN
    UPDATE public.tenant_members SET user_id=NEW.id, phone=login_phone,
      tenant_role=coalesce(requested_role, tenant_role)
    WHERE id=(profile->>'member_id')::uuid AND user_id IS NULL AND NOT disabled
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

CREATE OR REPLACE FUNCTION public.bind_hosting_group_on_account_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE selection jsonb := NEW.raw_app_meta_data->'cake_dashboard_account'->'hosting_binding'; member_id uuid;
BEGIN
  IF selection IS NULL OR (TG_OP='UPDATE' AND OLD.raw_app_meta_data->'cake_dashboard_account' ? 'hosting_binding') THEN RETURN NEW; END IF;
  SELECT a.id INTO STRICT member_id FROM public.tenant_members a WHERE a.user_id=NEW.id;
  PERFORM public.bind_dashboard_hosting_group('stride-primary',member_id,NEW.raw_app_meta_data->'cake_dashboard_account'->>'organization',selection->>'groupId',
    selection->>'previousGroupId',(selection->>'previousOwnerId')::uuid,(selection->>'actor')::uuid);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.bind_dashboard_hosting_group(
  p_connection_id text,p_member_id uuid,p_tenant text,p_group_id text,p_previous_group text,p_previous_owner uuid,p_actor uuid
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE member tenant_members%ROWTYPE; owner tenant_members%ROWTYPE; scan hosting_directory_scans%ROWTYPE;
  registered_tenant text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  IF NOT EXISTS(SELECT FROM tenant_members WHERE user_id=p_actor AND login_name='cakeadmin' AND NOT disabled)
    THEN RAISE EXCEPTION '需要管理员账号' USING ERRCODE='42501'; END IF;
  SELECT * INTO scan FROM hosting_directory_scans WHERE connection_id=p_connection_id;
  IF scan.checked_at IS NULL OR scan.checked_at<clock_timestamp()-interval '10 minutes'
    OR NOT EXISTS(SELECT FROM jsonb_to_recordset(scan.groups) g(id text) WHERE id=p_group_id)
    THEN RAISE EXCEPTION '请同步 Stride 目录后重新选择小组' USING ERRCODE='23514'; END IF;
  SELECT * INTO member FROM tenant_members WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND OR member.disabled OR member.login_name IS NOT NULL OR member.organization IS DISTINCT FROM p_tenant
    THEN RAISE EXCEPTION '请选择有效的托管成员' USING ERRCODE='23514'; END IF;
  SELECT tenant_id INTO registered_tenant FROM hosting_current_groups WHERE connection_id=p_connection_id AND group_id=p_group_id;
  IF FOUND AND registered_tenant IS DISTINCT FROM member.organization
    THEN RAISE EXCEPTION '小组已归其他组织或已停用，请核对归属' USING ERRCODE='23514'; END IF;
  SELECT * INTO owner FROM tenant_members WHERE hosting_group_id=p_group_id FOR UPDATE;
  IF owner.id IS DISTINCT FROM member.id THEN
    IF owner.id IS DISTINCT FROM p_previous_owner OR member.hosting_group_id IS DISTINCT FROM p_previous_group
      OR (owner.id IS NOT NULL AND owner.organization<>member.organization)
      THEN RAISE EXCEPTION '小组负责人已变化，请刷新后核对交接' USING ERRCODE='23514'; END IF;
    UPDATE tenant_members SET hosting_group_id=NULL WHERE id=owner.id;
    UPDATE tenant_members SET hosting_group_id=p_group_id WHERE id=member.id;
    INSERT INTO hosting_owner_changes(connection_id,group_id,previous_member,member_id,member_previous_group,actor_id)
      VALUES(p_connection_id,p_group_id,owner.id,member.id,member.hosting_group_id,p_actor);
  END IF;
  PERFORM register_hosting_directory(p_connection_id,jsonb_build_array(jsonb_build_object(
    'group_id',p_group_id,'tenant_id',member.organization,'bot_im_ids',
    (SELECT coalesce(jsonb_agg(b.id),'[]') FROM jsonb_to_recordset(scan.bots) b(id text,group_id text)
      WHERE b.group_id=p_group_id))),false);
END $$;

CREATE OR REPLACE FUNCTION public.hosting_management_directory(p_connection_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH scan AS (SELECT * FROM hosting_directory_scans WHERE connection_id=p_connection_id),
    groups AS (SELECT g.* FROM scan,jsonb_to_recordset(scan.groups) g(id text,name text)),
    bots AS (SELECT b.* FROM scan,jsonb_to_recordset(scan.bots) b(id text,name text,group_id text)),
    bot_lists AS (SELECT group_id,jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) AS items
      FROM bots GROUP BY group_id)
  SELECT jsonb_build_object('tenants', (SELECT coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id),'[]') FROM tenants),
    'checkedAt',(SELECT checked_at FROM scan),'groups',coalesce((
    SELECT jsonb_agg(jsonb_build_object('id',g.id,'name',g.name,'tenantId',o.tenant_id,'ownerId',a.id,
        'ownerName',a.name,'bots',coalesce(l.items,'[]')) ORDER BY g.name,g.id)
    FROM groups g LEFT JOIN hosting_current_groups o ON o.connection_id=p_connection_id AND o.group_id=g.id
      LEFT JOIN tenant_members a ON a.hosting_group_id=g.id LEFT JOIN bot_lists l ON l.group_id=g.id
  ),'[]'))
$$;

CREATE OR REPLACE FUNCTION public.import_dashboard_staff_roster(members jsonb, validate_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE m record; a public.tenant_members%ROWTYPE;
BEGIN
  IF NOT validate_only THEN LOCK TABLE public.tenant_members IN SHARE ROW EXCLUSIVE MODE; END IF;
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
      SELECT * INTO STRICT a FROM public.tenant_members
        WHERE phone=m.phone OR feishu_open_id=m.feishu_open_id OR hosting_group_id=m.hosting_group_id;
    EXCEPTION WHEN no_data_found THEN
      IF NOT validate_only THEN
        INSERT INTO public.tenant_members(name,phone,organization,tenant_role,hosting_group_id,feishu_open_id)
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
      UPDATE public.tenant_members SET phone=coalesce(a.phone,m.phone),
        tenant_role=CASE WHEN a.user_id IS NULL THEN coalesce(m.tenant_role,a.tenant_role) ELSE a.tenant_role END,
        hosting_group_id=coalesce(a.hosting_group_id,m.hosting_group_id),
        feishu_open_id=coalesce(a.feishu_open_id,m.feishu_open_id)
        WHERE id=a.id;
    END IF;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION public.import_dashboard_henan_roster(members jsonb) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  imported integer;
BEGIN
  INSERT INTO public.tenant_members AS a (phone, name, organization, hosting_group_id)
  SELECT m.phone, m.name, 'henan', m.hosting_group_id
  FROM jsonb_to_recordset(members) AS m(phone text, name text, hosting_group_id text)
  ON CONFLICT (phone) DO UPDATE SET hosting_group_id =
    CASE WHEN a.disabled THEN a.hosting_group_id ELSE coalesce(a.hosting_group_id, EXCLUDED.hosting_group_id) END
  WHERE a.organization = EXCLUDED.organization AND a.name = EXCLUDED.name
    AND (a.hosting_group_id IS NULL OR EXCLUDED.hosting_group_id IS NULL OR a.hosting_group_id = EXCLUDED.hosting_group_id);
  GET DIAGNOSTICS imported = ROW_COUNT;
  IF imported <> jsonb_array_length(members) THEN
    RAISE EXCEPTION 'Roster identity or group ownership conflicts with an existing account' USING ERRCODE = '23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.disable_banned_dashboard_account() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.tenant_members SET disabled = true WHERE user_id = NEW.id AND NOT disabled;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION public.keep_dashboard_headquarters_account() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  PERFORM pg_catalog.pg_advisory_xact_lock(20261120, 1);
  IF NOT EXISTS (
    SELECT FROM public.tenant_members
    WHERE organization = 'headquarters' AND NOT disabled AND user_id IS NOT NULL AND user_id <> OLD.user_id
  ) THEN RAISE EXCEPTION 'The dashboard needs an active headquarters account' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;

NOTIFY pgrst, 'reload schema';
