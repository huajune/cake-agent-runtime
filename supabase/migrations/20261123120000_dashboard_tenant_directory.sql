-- The registry holds each tenant's data scope. The administrator-only creation
-- endpoint accepts a name and uses the restricted defaults for every new tenant.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS reads_all_tenants boolean NOT NULL DEFAULT false;
UPDATE public.tenants SET reads_all_tenants=true WHERE id='headquarters';

-- Existing integration destinations are configuration. New organizations start without a destination.
ALTER TABLE public.tenants ADD COLUMN IF NOT EXISTS feishu_route text
  CHECK (feishu_route IN ('internal','henan'));
UPDATE public.tenants SET feishu_route='internal' WHERE id IN ('headquarters','shanghai_recruitment');
UPDATE public.tenants SET feishu_route='henan' WHERE id='henan';

CREATE OR REPLACE FUNCTION public.hosting_feishu_route(p_connection_id text,p_bot text,p_at timestamptz)
RETURNS text LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT feishu_route FROM tenants WHERE id=hosting_tenant_at(p_connection_id,p_bot,NULL,p_at)
$$;
REVOKE ALL ON FUNCTION public.hosting_feishu_route(text,text,timestamptz) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hosting_feishu_route(text,text,timestamptz) TO service_role;

-- 已登记的组织和显示名称来自 tenants。名单预检与实际开户使用同一组织外键。
CREATE OR REPLACE FUNCTION public.import_dashboard_staff_roster(members jsonb, validate_only boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE m record; a public.dashboard_accounts%ROWTYPE;
BEGIN
  IF NOT validate_only THEN LOCK TABLE public.dashboard_accounts IN SHARE ROW EXCLUSIVE MODE; END IF;
  FOR m IN SELECT * FROM jsonb_to_recordset(members)
    AS x(name text, phone text, organization text, hosting_group_id text, feishu_open_id text)
  LOOP
    IF m.name IS NULL OR btrim(m.name) = '' OR m.organization IS NULL
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
      LEFT JOIN dashboard_accounts a ON a.hosting_group_id=g.id LEFT JOIN bot_lists l ON l.group_id=g.id
  ),'[]'),'handovers',coalesce((
    SELECT jsonb_agg(jsonb_build_object('id',h.id,'botId',h.bot_im_id,'botName',coalesce(b.name,h.bot_im_id),
      'fromGroupId',h.from_group_id,'toGroupId',h.to_group_id,'reviewFrom',h.review_from,'targetChangedSince',h.target_changed_since,'detectedAt',h.detected_at)
      ORDER BY h.detected_at,h.bot_im_id) FROM hosting_bot_handovers h LEFT JOIN bots b ON b.id=h.bot_im_id
      WHERE h.connection_id=p_connection_id AND h.confirmed_at IS NULL
  ),'[]'))
$$;

CREATE OR REPLACE FUNCTION public.hosting_scope_bindings(p_connection_id text,p_groups text[],p_bots text[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('groups',coalesce((SELECT jsonb_object_agg(group_id,tenant_id)
    FROM hosting_current_groups WHERE connection_id=p_connection_id AND group_id=ANY(p_groups) AND tenant_id IS NOT NULL),'{}'),
    'tenantNames',coalesce((SELECT jsonb_object_agg(t.id,t.name) FROM tenants t
      WHERE EXISTS (SELECT FROM hosting_current_groups g WHERE g.connection_id=p_connection_id AND g.group_id=ANY(p_groups) AND g.tenant_id=t.id)),'{}'),
    'bots',coalesce((SELECT jsonb_object_agg(m.bot_im_id,m.group_id) FROM hosting_current_bots m
    WHERE m.connection_id=p_connection_id AND m.bot_im_id=ANY(p_bots) AND m.group_id IS NOT NULL AND NOT EXISTS(
      SELECT FROM hosting_bot_handovers h WHERE h.connection_id=m.connection_id AND h.bot_im_id=m.bot_im_id AND h.confirmed_at IS NULL)),'{}'))
$$;
