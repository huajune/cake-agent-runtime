-- The bounded Stride snapshot is replaced only after both complete directories were verified.
CREATE TABLE IF NOT EXISTS public.hosting_directory_scans (
  connection_id text PRIMARY KEY,
  started_at timestamptz NOT NULL,
  checked_at timestamptz NOT NULL,
  groups jsonb NOT NULL,
  bots jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS public.hosting_bot_handovers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id text NOT NULL,
  bot_im_id text NOT NULL,
  from_group_id text,
  to_group_id text,
  review_from timestamptz NOT NULL,
  detected_at timestamptz NOT NULL,
  target_changed_since timestamptz,
  confirmed_at timestamptz,
  effective_at timestamptz,
  actor_id uuid,
  cursor_time timestamptz,
  cursor_message text,
  reconciled boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_hosting_open_handover
  ON public.hosting_bot_handovers(connection_id,bot_im_id) WHERE confirmed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_hosting_review_window
  ON public.hosting_bot_handovers(connection_id,bot_im_id,review_from) WHERE NOT reconciled;
CREATE INDEX IF NOT EXISTS idx_hosting_handover_backlog
  ON public.hosting_bot_handovers(connection_id,confirmed_at,id) WHERE confirmed_at IS NOT NULL AND NOT reconciled;
CREATE INDEX IF NOT EXISTS idx_hosting_chat_reconciliation
  ON public.chat_messages(hosting_connection_id,im_bot_id,timestamp,message_id) WHERE hosting_connection_id IS NOT NULL;
ALTER TABLE public.hosting_directory_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hosting_bot_handovers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hosting_directory_scans,public.hosting_bot_handovers FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE ON public.hosting_directory_scans,public.hosting_bot_handovers TO service_role;

CREATE TABLE IF NOT EXISTS public.hosting_owner_changes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, connection_id text NOT NULL, group_id text NOT NULL,
  previous_member uuid, member_id uuid NOT NULL, member_previous_group text, actor_id uuid NOT NULL,
  effective_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.hosting_owner_changes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.hosting_owner_changes FROM PUBLIC,anon,authenticated;
GRANT INSERT ON public.hosting_owner_changes TO service_role;
REVOKE ALL ON SEQUENCE public.hosting_owner_changes_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SEQUENCE public.hosting_owner_changes_id_seq TO service_role;

-- A pending member may temporarily have no group after a same-tenant handoff.
ALTER TABLE public.dashboard_accounts DROP CONSTRAINT IF EXISTS dashboard_login_identity;
ALTER TABLE public.dashboard_accounts ADD CONSTRAINT dashboard_login_identity CHECK (
  (login_name IS NULL AND (phone IS NOT NULL OR user_id IS NULL))
  OR (login_name='cakeadmin' AND login_name IS NOT NULL AND user_id IS NOT NULL AND organization='headquarters'
      AND phone IS NULL AND hosting_group_id IS NULL AND feishu_open_id IS NULL)
);

CREATE OR REPLACE VIEW public.hosting_current_groups WITH (security_invoker=true) AS
  SELECT DISTINCT ON (connection_id,group_id) connection_id,group_id,tenant_id,effective_from
  FROM public.hosting_group_ownership WHERE effective_from<=clock_timestamp()
  ORDER BY connection_id,group_id,effective_from DESC;
CREATE OR REPLACE VIEW public.hosting_current_bots WITH (security_invoker=true) AS
  SELECT DISTINCT ON (connection_id,bot_im_id) connection_id,bot_im_id,group_id,effective_from
  FROM public.hosting_bot_memberships WHERE effective_from<=clock_timestamp()
  ORDER BY connection_id,bot_im_id,effective_from DESC;
REVOKE ALL ON public.hosting_current_groups,public.hosting_current_bots FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.hosting_current_groups,public.hosting_current_bots TO service_role;

CREATE OR REPLACE FUNCTION public.sync_hosting_directory(
  p_connection_id text,p_started_at timestamptz,p_groups jsonb,p_bots jsonb
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp SET statement_timeout='8s' AS $$
DECLARE previous hosting_directory_scans%ROWTYPE; checked timestamptz;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  SELECT * INTO previous FROM hosting_directory_scans WHERE connection_id=p_connection_id;
  IF previous.started_at>=p_started_at THEN RETURN; END IF;
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

  -- An incomplete or stale fetch never reaches this point. Open reviews survive repeated observations.
  WITH observed AS MATERIALIZED (SELECT * FROM jsonb_to_recordset(p_bots) b(id text,group_id text))
  UPDATE hosting_bot_handovers h SET to_group_id=(SELECT group_id FROM observed WHERE id=h.bot_im_id),
    target_changed_since=greatest(h.review_from,previous.started_at)
    WHERE h.connection_id=p_connection_id AND h.confirmed_at IS NULL
      AND h.to_group_id IS DISTINCT FROM (SELECT group_id FROM observed WHERE id=h.bot_im_id);

  INSERT INTO hosting_bot_handovers(connection_id,bot_im_id,from_group_id,to_group_id,review_from,detected_at)
    SELECT p_connection_id,m.bot_im_id,m.group_id,b.group_id,
           greatest(m.effective_from,previous.started_at),checked
    FROM hosting_current_bots m LEFT JOIN jsonb_to_recordset(p_bots) b(id text,group_id text) ON b.id=m.bot_im_id
    WHERE m.connection_id=p_connection_id AND m.group_id IS DISTINCT FROM b.group_id
    ON CONFLICT(connection_id,bot_im_id) WHERE confirmed_at IS NULL DO NOTHING;

  INSERT INTO hosting_bot_memberships(connection_id,bot_im_id,effective_from,group_id)
    SELECT p_connection_id,b.id,checked,b.group_id FROM jsonb_to_recordset(p_bots) b(id text,group_id text)
    JOIN hosting_current_groups g ON g.connection_id=p_connection_id AND g.group_id=b.group_id AND g.tenant_id IS NOT NULL
    WHERE NOT EXISTS(SELECT FROM hosting_bot_memberships m WHERE m.connection_id=p_connection_id AND m.bot_im_id=b.id);

  INSERT INTO hosting_directory_scans VALUES(p_connection_id,p_started_at,checked,p_groups,p_bots)
    ON CONFLICT(connection_id) DO UPDATE SET started_at=excluded.started_at,checked_at=excluded.checked_at,
      groups=excluded.groups,bots=excluded.bots;
END $$;

CREATE OR REPLACE FUNCTION public.hosting_management_directory(p_connection_id text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  WITH scan AS (SELECT * FROM hosting_directory_scans WHERE connection_id=p_connection_id),
    groups AS (SELECT g.* FROM scan,jsonb_to_recordset(scan.groups) g(id text,name text)),
    bots AS (SELECT b.* FROM scan,jsonb_to_recordset(scan.bots) b(id text,name text,group_id text)),
    bot_lists AS (SELECT group_id,jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY name,id) AS items
      FROM bots GROUP BY group_id)
  SELECT jsonb_build_object('checkedAt',(SELECT checked_at FROM scan),'groups',coalesce((
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

CREATE OR REPLACE FUNCTION public.bind_dashboard_hosting_group(
  p_connection_id text,p_member_id uuid,p_tenant text,p_group_id text,p_previous_group text,p_previous_owner uuid,p_actor uuid
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE member dashboard_accounts%ROWTYPE; owner dashboard_accounts%ROWTYPE; scan hosting_directory_scans%ROWTYPE;
  registered_tenant text; effective timestamptz;
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
  effective := clock_timestamp();
  IF registered_tenant IS NULL THEN
    INSERT INTO hosting_group_ownership VALUES(p_connection_id,p_group_id,effective,member.organization);
  END IF;
  INSERT INTO hosting_bot_memberships(connection_id,bot_im_id,effective_from,group_id)
    SELECT p_connection_id,b.id,effective,p_group_id FROM jsonb_to_recordset(scan.bots) b(id text,group_id text)
    WHERE b.group_id=p_group_id AND NOT EXISTS(SELECT FROM hosting_bot_memberships m
      WHERE m.connection_id=p_connection_id AND m.bot_im_id=b.id);
END $$;

-- The original Auth roster trigger has already bound NEW.id. Both operations commit with GoTrue.
CREATE OR REPLACE FUNCTION public.bind_hosting_group_on_account_open() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE selection jsonb := NEW.raw_app_meta_data->'cake_dashboard_account'->'hosting_binding'; member_id uuid;
BEGIN
  IF selection IS NULL OR (TG_OP='UPDATE' AND OLD.raw_app_meta_data->'cake_dashboard_account' ? 'hosting_binding') THEN RETURN NEW; END IF;
  SELECT a.id INTO STRICT member_id FROM public.dashboard_accounts a WHERE a.user_id=NEW.id;
  PERFORM public.bind_dashboard_hosting_group('stride-primary',member_id,NEW.raw_app_meta_data->'cake_dashboard_account'->>'organization',selection->>'groupId',
    selection->>'previousGroupId',(selection->>'previousOwnerId')::uuid,(selection->>'actor')::uuid);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS dashboard_hosting_on_open ON auth.users;
CREATE TRIGGER dashboard_hosting_on_open AFTER INSERT OR UPDATE OF raw_app_meta_data ON auth.users
  FOR EACH ROW WHEN (NEW.raw_app_meta_data->'cake_dashboard_account' ? 'hosting_binding')
  EXECUTE FUNCTION public.bind_hosting_group_on_account_open();

CREATE OR REPLACE FUNCTION public.confirm_hosting_handover(
  p_connection_id text,p_id uuid,p_target_group text,p_effective_at timestamptz,p_actor uuid
) RETURNS void LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE h hosting_bot_handovers%ROWTYPE; scan hosting_directory_scans%ROWTYPE; target_tenant text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('cake.hosting.'||p_connection_id,0));
  IF NOT EXISTS(SELECT FROM dashboard_accounts WHERE user_id=p_actor AND login_name='cakeadmin' AND NOT disabled)
    THEN RAISE EXCEPTION '需要管理员账号' USING ERRCODE='42501'; END IF;
  SELECT * INTO h FROM hosting_bot_handovers WHERE connection_id=p_connection_id AND id=p_id FOR UPDATE;
  IF NOT FOUND OR h.to_group_id IS DISTINCT FROM p_target_group THEN
    RAISE EXCEPTION '交接目标已变化，请重新核对目录' USING ERRCODE='23514'; END IF;
  IF h.confirmed_at IS NOT NULL THEN
    IF h.effective_at=p_effective_at THEN RETURN; END IF;
    RAISE EXCEPTION '此交接已经确认' USING ERRCODE='23514'; END IF;
  SELECT * INTO scan FROM hosting_directory_scans WHERE connection_id=p_connection_id;
  IF scan.checked_at IS NULL OR scan.checked_at<clock_timestamp()-interval '10 minutes'
    OR p_effective_at IS NULL OR NOT isfinite(p_effective_at)
    OR p_effective_at<greatest(h.review_from,h.target_changed_since) OR p_effective_at>clock_timestamp() THEN
    RAISE EXCEPTION '请同步目录并填写上次核实之后的实际交接时间' USING ERRCODE='23514'; END IF;
  IF p_target_group IS NOT NULL THEN
    SELECT tenant_id INTO target_tenant FROM hosting_current_groups
      WHERE connection_id=p_connection_id AND group_id=p_target_group AND tenant_id IS NOT NULL;
    IF NOT FOUND OR EXISTS(SELECT FROM (SELECT tenant_id FROM hosting_group_ownership
      WHERE connection_id=p_connection_id AND group_id=p_target_group AND effective_from<=p_effective_at
      ORDER BY effective_from DESC LIMIT 1) old WHERE old.tenant_id IS DISTINCT FROM target_tenant) THEN
      RAISE EXCEPTION '请核对目标小组在交接时的组织' USING ERRCODE='23514'; END IF;
  END IF;
  IF EXISTS(SELECT FROM hosting_bot_memberships WHERE connection_id=p_connection_id AND bot_im_id=h.bot_im_id AND effective_from>=p_effective_at) THEN
    RAISE EXCEPTION '交接时间与已有绑定重叠' USING ERRCODE='23514'; END IF;
  -- If the bot disappeared and returned to the same group, its whereabouts in the gap are unknown.
  IF (p_target_group=h.from_group_id OR h.target_changed_since IS NOT NULL) AND h.review_from+interval '1 microsecond'<p_effective_at THEN
    INSERT INTO hosting_bot_memberships VALUES(p_connection_id,h.bot_im_id,h.review_from+interval '1 microsecond',NULL);
  END IF;
  INSERT INTO hosting_bot_memberships VALUES(p_connection_id,h.bot_im_id,p_effective_at,p_target_group);
  UPDATE hosting_bot_handovers SET effective_at=p_effective_at,actor_id=p_actor,confirmed_at=clock_timestamp() WHERE id=p_id;
END $$;

REVOKE ALL ON FUNCTION public.sync_hosting_directory(text,timestamptz,jsonb,jsonb),
  public.hosting_management_directory(text),public.bind_dashboard_hosting_group(text,uuid,text,text,text,uuid,uuid),
  public.bind_hosting_group_on_account_open(),public.confirm_hosting_handover(text,uuid,text,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.sync_hosting_directory(text,timestamptz,jsonb,jsonb),public.hosting_management_directory(text),
  public.bind_dashboard_hosting_group(text,uuid,text,text,text,uuid,uuid),public.confirm_hosting_handover(text,uuid,text,timestamptz,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.hosting_scope_bindings(p_connection_id text,p_groups text[],p_bots text[])
RETURNS jsonb LANGUAGE sql STABLE SET search_path=public,pg_temp AS $$
  SELECT jsonb_build_object('groups',coalesce((SELECT jsonb_object_agg(group_id,tenant_id)
    FROM hosting_current_groups WHERE connection_id=p_connection_id AND group_id=ANY(p_groups) AND tenant_id IS NOT NULL),'{}'),
    'bots',coalesce((SELECT jsonb_object_agg(m.bot_im_id,m.group_id) FROM hosting_current_bots m
    WHERE m.connection_id=p_connection_id AND m.bot_im_id=ANY(p_bots) AND m.group_id IS NOT NULL AND NOT EXISTS(
      SELECT FROM hosting_bot_handovers h WHERE h.connection_id=m.connection_id AND h.bot_im_id=m.bot_im_id AND h.confirmed_at IS NULL)),'{}'))
$$;
REVOKE ALL ON FUNCTION public.hosting_scope_bindings(text,text[],text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.hosting_scope_bindings(text,text[],text[]) TO service_role;
