BEGIN;
DO $$
DECLARE conn text:='stride-primary'; admin_id uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  member uuid; second_member uuid; auth_id uuid:=gen_random_uuid(); blocked_id uuid:=gen_random_uuid();
  groups jsonb:='[{"id":"source","name":"一组"},{"id":"dest","name":"二组"},{"id":"empty","name":"空组"},{"id":"peer","name":"河南二组"}]';
  bots jsonb:='[{"id":"new","name":"新号","group_id":"source"}]';
  moved jsonb:='[{"id":"new","name":"新号","group_id":"dest"}]';
  opened jsonb; starting timestamptz; observed timestamptz;
BEGIN
  IF has_function_privilege('authenticated','public.bind_dashboard_hosting_group(text,uuid,text,text,text,uuid,uuid)','execute')
    OR to_regprocedure('public.confirm_hosting_handover(text,uuid,text,timestamptz,uuid)') IS NOT NULL
    OR has_table_privilege('service_role','public.hosting_bot_memberships','INSERT')
    OR has_table_privilege('authenticated','public.tenant_visible_chat_messages','select')
    THEN RAISE EXCEPTION 'private permissions missing'; END IF;
  INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES(admin_id,'cakeadmin@dashboard.cake.invalid',
    '{"cake_dashboard_account":{"login_name":"cakeadmin","organization":"headquarters"}}');
  INSERT INTO tenant_members(name,organization,phone) VALUES('旧负责人','henan','+12025550111') RETURNING id INTO member;
  INSERT INTO tenant_members(name,organization,phone) VALUES('新负责人','henan','+12025550112') RETURNING id INTO second_member;
  INSERT INTO hosting_group_ownership VALUES(conn,'dest',clock_timestamp()-interval '1 year','shanghai_recruitment'),
    (conn,'peer',clock_timestamp()-interval '1 year','henan');
  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,'[]');
  PERFORM bind_dashboard_hosting_group(conn,member,'henan','source',NULL,NULL,admin_id);
  PERFORM bind_dashboard_hosting_group(conn,member,'henan','source',NULL,NULL,admin_id);
  BEGIN
    PERFORM bind_dashboard_hosting_group(conn,second_member,'henan','source',NULL,NULL,admin_id);
    RAISE EXCEPTION 'stale owner accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    PERFORM bind_dashboard_hosting_group(conn,second_member,'henan','source',NULL,member,outsider);
    RAISE EXCEPTION 'ordinary member acted as admin';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM bind_dashboard_hosting_group(conn,second_member,'henan','dest',NULL,NULL,admin_id);
    RAISE EXCEPTION 'cross-tenant group claimed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  PERFORM bind_dashboard_hosting_group(conn,second_member,'henan','source',NULL,member,admin_id);
  IF (SELECT hosting_group_id FROM tenant_members WHERE id=member) IS NOT NULL OR
     (SELECT hosting_group_id FROM tenant_members WHERE id=second_member) IS DISTINCT FROM 'source'
    THEN RAISE EXCEPTION 'same-tenant owner handoff was not atomic'; END IF;
  opened:=jsonb_build_object('cake_dashboard_account',jsonb_build_object('organization','headquarters','name','新同事',
    'hosting_binding',jsonb_build_object('groupId','empty','previousGroupId',NULL,'previousOwnerId',NULL,'actor',admin_id)));
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(auth_id,'12025550113',opened);
  IF NOT EXISTS(SELECT FROM tenant_members WHERE user_id=auth_id AND hosting_group_id='empty')
    THEN RAISE EXCEPTION 'opening did not bind an empty group'; END IF;
  BEGIN
    INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(blocked_id,'12025550114',opened);
    RAISE EXCEPTION 'opening despite conflicting selection';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS(SELECT FROM auth.users WHERE id=blocked_id) OR EXISTS(SELECT FROM tenant_members WHERE phone='+12025550114')
    THEN RAISE EXCEPTION 'failed combined operation left an identity'; END IF;

  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,bots);
  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,bots);
  IF (SELECT count(*) FROM hosting_bot_memberships WHERE connection_id=conn AND bot_im_id='new')<>1
    THEN RAISE EXCEPTION 'new bot sync not idempotent'; END IF;
  starting:=clock_timestamp();
  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id)
    VALUES ('ops-test','ops-before','user','before',starting,'new',conn);
  -- A different organization's directory entry is a configuration error. A rejected snapshot changes nothing.
  BEGIN
    PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
    RAISE EXCEPTION 'accepted a Bot assigned to the wrong organization';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF (SELECT d.bots FROM hosting_directory_scans d WHERE d.connection_id=conn) IS DISTINCT FROM bots OR
     (SELECT tenant_id FROM tenant_visible_chat_messages WHERE message_id='ops-before') IS DISTINCT FROM 'henan'
    THEN RAISE EXCEPTION 'bad snapshot changed the directory or message'; END IF;
  moved := '[{"id":"new","name":"新号","group_id":"peer"}]';
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
  observed:=clock_timestamp();
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
  PERFORM sync_hosting_directory(conn,starting,groups,bots);
  IF hosting_scope_bindings(conn,ARRAY['source','peer'],ARRAY['new'])->'bots'->>'new' IS DISTINCT FROM 'peer' OR
     (SELECT count(*) FROM hosting_bot_memberships WHERE connection_id=conn AND bot_im_id='new')<>2 OR
     hosting_tenant_at(conn,'new','source',observed) IS DISTINCT FROM 'henan'
    THEN RAISE EXCEPTION 'same-organization group change or directory replay failed'; END IF;
  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id,hosting_observed_group_id)
    VALUES ('ops-test','ops-current','user','same organization',observed,'new',conn,'peer'),
           ('ops-test','ops-conflict','user','conflicting directory',observed,'new',conn,'dest');
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,'[]');
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
  IF (SELECT tenant_id FROM tenant_visible_chat_messages WHERE message_id='ops-current') IS DISTINCT FROM 'henan' OR
     EXISTS(SELECT FROM tenant_visible_chat_messages WHERE message_id='ops-conflict') OR
     hosting_tenant_at(conn,'new',NULL,clock_timestamp()) IS DISTINCT FROM 'henan' OR
     hosting_management_directory(conn) ? 'handovers'
    THEN RAISE EXCEPTION 'directory refresh changed business ownership'; END IF;
END $$;
ROLLBACK;
