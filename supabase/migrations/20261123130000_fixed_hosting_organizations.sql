-- A registered group and its Bots belong to one organization. Only the group within that organization may change.

CREATE OR REPLACE FUNCTION public.register_hosting_directory(
  p_connection_id text, p_groups jsonb, p_check_only boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g record; bot text; prev text; previous_tenant text; observed_at timestamptz;
BEGIN
  IF nullif(btrim(p_connection_id),'') IS NULL OR p_connection_id<>btrim(p_connection_id)
    OR jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_array_length(p_groups) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid hosting directory';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.' || p_connection_id, 0));
  observed_at := clock_timestamp();
  IF EXISTS (SELECT FROM jsonb_array_elements(p_groups) item GROUP BY item.value->>'group_id' HAVING count(*)>1)
    OR EXISTS (SELECT FROM jsonb_array_elements(p_groups) item, jsonb_array_elements_text(item.value->'bot_im_ids') b
               GROUP BY b.value HAVING count(*)>1) THEN RAISE EXCEPTION 'duplicate directory identity'; END IF;
  FOR g IN SELECT * FROM jsonb_to_recordset(p_groups) AS x(group_id text,tenant_id text,bot_im_ids text[]) LOOP
    IF nullif(btrim(g.group_id),'') IS NULL OR g.group_id<>btrim(g.group_id) OR g.bot_im_ids IS NULL OR
      NOT EXISTS (SELECT FROM public.tenants t WHERE t.id=g.tenant_id) THEN RAISE EXCEPTION 'invalid tenant or group'; END IF;
    SELECT h.tenant_id INTO prev FROM public.hosting_group_ownership h
      WHERE h.connection_id=p_connection_id AND h.group_id=g.group_id AND h.effective_from<=observed_at
      ORDER BY h.effective_from DESC LIMIT 1;
    IF FOUND THEN
      IF prev IS DISTINCT FROM g.tenant_id THEN RAISE EXCEPTION '小组已登记在其他组织，请核对目录' USING ERRCODE='23514'; END IF;
    ELSIF p_check_only IS FALSE THEN
      INSERT INTO public.hosting_group_ownership VALUES(p_connection_id,g.group_id,observed_at,g.tenant_id);
    END IF;
    FOREACH bot IN ARRAY g.bot_im_ids LOOP
      IF nullif(btrim(bot),'') IS NULL OR bot<>btrim(bot) THEN RAISE EXCEPTION 'invalid bot identity'; END IF;
      SELECT m.group_id, org.tenant_id INTO prev, previous_tenant
        FROM public.hosting_current_bots m
        LEFT JOIN public.hosting_current_groups org ON org.connection_id=m.connection_id AND org.group_id=m.group_id
        WHERE m.connection_id=p_connection_id AND m.bot_im_id=bot;
      IF FOUND AND previous_tenant IS DISTINCT FROM g.tenant_id THEN
        RAISE EXCEPTION '托管号和小组所属组织不一致，请核对 Stride 目录' USING ERRCODE='23514';
      END IF;
      IF prev IS DISTINCT FROM g.group_id AND p_check_only IS FALSE THEN
        INSERT INTO public.hosting_bot_memberships VALUES(p_connection_id,bot,observed_at,g.group_id);
      END IF;
    END LOOP;
  END LOOP;
END $$;

REVOKE INSERT ON public.hosting_group_ownership,public.hosting_bot_memberships FROM service_role;

CREATE OR REPLACE FUNCTION public.sync_hosting_directory(
  p_connection_id text,p_started_at timestamptz,p_groups jsonb,p_bots jsonb
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='8s' AS $$
DECLARE previous_start timestamptz; checked timestamptz; registered jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  SELECT started_at INTO previous_start FROM hosting_directory_scans WHERE connection_id=p_connection_id;
  IF previous_start>=p_started_at THEN RETURN; END IF;
  checked := clock_timestamp();
  IF p_started_at IS NULL OR abs(extract(epoch FROM checked-p_started_at))>120
    OR jsonb_typeof(p_groups) IS DISTINCT FROM 'array' OR jsonb_typeof(p_bots) IS DISTINCT FROM 'array'
    OR jsonb_array_length(p_groups)>2000 OR jsonb_array_length(p_bots)>10000
    THEN RAISE EXCEPTION '目录未完整读取或快照已过期' USING ERRCODE='22023'; END IF;
  IF EXISTS (SELECT FROM jsonb_to_recordset(p_groups) g(id text,name text)
             GROUP BY id HAVING count(*)>1 OR nullif(btrim(id),'') IS NULL OR bool_or(name IS NULL))
    OR EXISTS (SELECT FROM jsonb_to_recordset(p_bots) b(id text,group_id text) GROUP BY id
               HAVING count(*)>1 OR nullif(btrim(id),'') IS NULL)
    OR EXISTS (SELECT FROM jsonb_to_recordset(p_bots) b(group_id text)
               LEFT JOIN jsonb_to_recordset(p_groups) g(id text) ON g.id=b.group_id WHERE g.id IS NULL)
    THEN RAISE EXCEPTION '两份 Stride 目录不一致，请重新同步' USING ERRCODE='22023'; END IF;

  -- Only registered groups can assign an organization. Absence from a scan does not change ownership.
  WITH bot_lists AS (
    SELECT b.group_id, jsonb_agg(b.id) AS ids FROM jsonb_to_recordset(p_bots) b(id text,group_id text)
    GROUP BY b.group_id
  )
  SELECT jsonb_agg(jsonb_build_object('group_id',g.id,'tenant_id',o.tenant_id,'bot_im_ids',coalesce(b.ids,'[]')))
    INTO registered FROM jsonb_to_recordset(p_groups) g(id text)
    JOIN hosting_current_groups o ON o.connection_id=p_connection_id AND o.group_id=g.id AND o.tenant_id IS NOT NULL
    LEFT JOIN bot_lists b ON b.group_id=g.id;
  IF registered IS NOT NULL THEN
    PERFORM register_hosting_directory(p_connection_id,registered,false);
  END IF;

  INSERT INTO hosting_directory_scans VALUES(p_connection_id,p_started_at,checked,p_groups,p_bots)
    ON CONFLICT(connection_id) DO UPDATE SET started_at=excluded.started_at,checked_at=excluded.checked_at,
      groups=excluded.groups,bots=excluded.bots;
END $$;

CREATE OR REPLACE FUNCTION public.bind_dashboard_hosting_group(
  p_connection_id text,p_member_id uuid,p_tenant text,p_group_id text,p_previous_group text,p_previous_owner uuid,p_actor uuid
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE member dashboard_accounts%ROWTYPE; owner dashboard_accounts%ROWTYPE; scan hosting_directory_scans%ROWTYPE;
  registered_tenant text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  IF NOT EXISTS(SELECT FROM dashboard_accounts WHERE user_id=p_actor AND login_name='cakeadmin' AND NOT disabled)
    THEN RAISE EXCEPTION '需要管理员账号' USING ERRCODE='42501'; END IF;
  SELECT * INTO scan FROM hosting_directory_scans WHERE connection_id=p_connection_id;
  IF scan.checked_at IS NULL OR scan.checked_at<clock_timestamp()-interval '10 minutes'
    OR NOT EXISTS(SELECT FROM jsonb_to_recordset(scan.groups) g(id text) WHERE id=p_group_id)
    THEN RAISE EXCEPTION '请同步 Stride 目录后重新选择小组' USING ERRCODE='23514'; END IF;
  SELECT * INTO member FROM dashboard_accounts WHERE id=p_member_id FOR UPDATE;
  IF NOT FOUND OR member.disabled OR member.login_name IS NOT NULL OR member.organization IS DISTINCT FROM p_tenant
    THEN RAISE EXCEPTION '请选择有效的托管成员' USING ERRCODE='23514'; END IF;
  SELECT tenant_id INTO registered_tenant FROM hosting_current_groups WHERE connection_id=p_connection_id AND group_id=p_group_id;
  IF FOUND AND registered_tenant IS DISTINCT FROM member.organization
    THEN RAISE EXCEPTION '小组已归其他组织或已停用，请核对归属' USING ERRCODE='23514'; END IF;
  SELECT * INTO owner FROM dashboard_accounts WHERE hosting_group_id=p_group_id FOR UPDATE;
  IF owner.id IS DISTINCT FROM member.id THEN
    IF owner.id IS DISTINCT FROM p_previous_owner OR member.hosting_group_id IS DISTINCT FROM p_previous_group
      OR (owner.id IS NOT NULL AND owner.organization<>member.organization)
      THEN RAISE EXCEPTION '小组负责人已变化，请刷新后核对交接' USING ERRCODE='23514'; END IF;
    UPDATE dashboard_accounts SET hosting_group_id=NULL WHERE id=owner.id;
    UPDATE dashboard_accounts SET hosting_group_id=p_group_id WHERE id=member.id;
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
      LEFT JOIN dashboard_accounts a ON a.hosting_group_id=g.id LEFT JOIN bot_lists l ON l.group_id=g.id
  ),'[]'))
$$;

CREATE OR REPLACE FUNCTION public.hosting_scope_bindings(p_connection_id text,p_groups text[],p_bots text[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('groups',coalesce((SELECT jsonb_object_agg(group_id,tenant_id)
    FROM hosting_current_groups WHERE connection_id=p_connection_id AND group_id=ANY(p_groups) AND tenant_id IS NOT NULL),'{}'),
    'tenantNames',coalesce((SELECT jsonb_object_agg(t.id,t.name) FROM tenants t
      WHERE EXISTS (SELECT FROM hosting_current_groups g WHERE g.connection_id=p_connection_id AND g.group_id=ANY(p_groups) AND g.tenant_id=t.id)),'{}'),
    'bots',coalesce((SELECT jsonb_object_agg(m.bot_im_id,m.group_id) FROM hosting_current_bots m
    WHERE m.connection_id=p_connection_id AND m.bot_im_id=ANY(p_bots) AND m.group_id IS NOT NULL),'{}'))
$$;

-- The original event group may identify a new Bot. Two groups in the same organization agree.
CREATE OR REPLACE FUNCTION public.hosting_tenant_at(
  p_connection_id text,p_bot_im_id text,p_group_id text,p_occurred_at timestamptz
) RETURNS text LANGUAGE plpgsql STABLE SET search_path=public,pg_temp AS $$
DECLARE registered_group text; bot_owner text; event_owner text;
BEGIN
  SELECT group_id INTO registered_group FROM hosting_bot_memberships
    WHERE connection_id=p_connection_id AND bot_im_id=p_bot_im_id AND effective_from<=p_occurred_at
    ORDER BY effective_from DESC LIMIT 1;
  IF FOUND THEN
    IF registered_group IS NULL THEN RETURN NULL; END IF;
    SELECT tenant_id INTO bot_owner FROM hosting_group_ownership
      WHERE connection_id=p_connection_id AND group_id=registered_group AND effective_from<=p_occurred_at
      ORDER BY effective_from DESC LIMIT 1;
    IF p_group_id IS NULL OR p_group_id=registered_group THEN RETURN bot_owner; END IF;
  END IF;
  SELECT tenant_id INTO event_owner FROM hosting_group_ownership
    WHERE connection_id=p_connection_id AND group_id=p_group_id AND effective_from<=p_occurred_at
    ORDER BY effective_from DESC LIMIT 1;
  IF registered_group IS NOT NULL AND bot_owner IS DISTINCT FROM event_owner THEN RETURN NULL; END IF;
  RETURN event_owner;
END $$;

CREATE OR REPLACE FUNCTION public.assign_chat_tenant() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE resolved text;
BEGIN
  IF TG_OP='UPDATE' AND OLD.tenant_id IS NOT NULL THEN
    IF ROW(NEW.tenant_id, NEW.hosting_connection_id, NEW.hosting_group_id, NEW.hosting_observed_group_id, NEW.im_bot_id, NEW.timestamp)
       IS DISTINCT FROM ROW(OLD.tenant_id, OLD.hosting_connection_id, OLD.hosting_group_id, OLD.hosting_observed_group_id, OLD.im_bot_id, OLD.timestamp) THEN
      RAISE EXCEPTION 'chat tenant and its ownership evidence are immutable' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.hosting_connection_id IS NOT NULL THEN
    resolved := public.hosting_tenant_at(NEW.hosting_connection_id, NEW.im_bot_id, NEW.hosting_group_id, NEW.timestamp);
    IF NEW.hosting_observed_group_id IS NOT NULL AND resolved IS NOT NULL AND NOT EXISTS (
      SELECT FROM public.hosting_current_groups WHERE connection_id=NEW.hosting_connection_id
        AND group_id=NEW.hosting_observed_group_id AND tenant_id=resolved
    ) THEN resolved := NULL; END IF;
  END IF;
  IF NEW.tenant_id IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM resolved THEN
    RAISE EXCEPTION 'chat tenant is inconsistent with the registered ownership' USING ERRCODE='23514';
  END IF;
  NEW.tenant_id := resolved;
  RETURN NEW;
END $$;

CREATE OR REPLACE VIEW public.tenant_visible_chat_messages WITH (security_invoker=true) AS
  SELECT * FROM public.chat_messages WHERE tenant_id IS NOT NULL;
CREATE OR REPLACE VIEW public.tenant_visible_message_processing_records WITH (security_invoker=true) AS
  SELECT * FROM public.message_processing_records WHERE tenant_id IS NOT NULL;
CREATE OR REPLACE VIEW public.tenant_visible_reengagement_touch_records WITH (security_invoker=true) AS
  SELECT * FROM public.reengagement_touch_records WHERE tenant_id IS NOT NULL;
CREATE OR REPLACE VIEW public.tenant_visible_ops_events WITH (security_invoker=true) AS
  SELECT * FROM public.ops_events WHERE tenant_id IS NOT NULL;

-- Retire the confirmation APIs and the worker's write locks. Existing business rows stay intact.
DROP FUNCTION public.confirm_hosting_handover(text,uuid,text,timestamptz,uuid);
DROP FUNCTION public.reconcile_hosting_handover(text);
DROP FUNCTION public.reconcile_business_handover(text);
DROP TRIGGER aa_lock_ops_tenant ON public.ops_events;
DROP TRIGGER aa_lock_processing_tenant ON public.message_processing_records;
DROP TRIGGER aa_lock_touch_tenant ON public.reengagement_touch_records;
DROP TRIGGER aa_lock_handoff_tenant ON public.handoff_events;
DROP FUNCTION public.lock_business_event_write();
DROP FUNCTION public.rebuild_tenant_ops_day(text,date,text);
REVOKE ALL ON public.hosting_bot_handovers FROM service_role;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM public.hosting_bot_handovers) THEN
    DROP TABLE public.hosting_bot_handovers;
  END IF;
END $$;
