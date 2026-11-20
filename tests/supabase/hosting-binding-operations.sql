BEGIN;
DO $$
DECLARE conn text:='stride-primary'; admin_id uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid();
  member uuid; second_member uuid; auth_id uuid:=gen_random_uuid(); blocked_id uuid:=gen_random_uuid();
  groups jsonb:='[{"id":"source","name":"一组"},{"id":"dest","name":"二组"},{"id":"empty","name":"空组"}]';
  bots jsonb:='[{"id":"new","name":"新号","group_id":"source"}]';
  moved jsonb:='[{"id":"new","name":"新号","group_id":"dest"}]';
  opened jsonb; h hosting_bot_handovers%ROWTYPE; cutoff timestamptz; starting timestamptz;
BEGIN
  IF has_function_privilege('authenticated','public.bind_dashboard_hosting_group(text,uuid,text,text,text,uuid,uuid)','execute')
    OR has_function_privilege('anon','public.confirm_hosting_handover(text,uuid,text,timestamptz,uuid)','execute')
    OR has_table_privilege('authenticated','public.tenant_visible_chat_messages','select')
    THEN RAISE EXCEPTION 'private permissions missing'; END IF;
  INSERT INTO auth.users(id,email,raw_app_meta_data) VALUES(admin_id,'cakeadmin@dashboard.cake.invalid',
    '{"cake_dashboard_account":{"login_name":"cakeadmin","organization":"headquarters"}}');
  INSERT INTO dashboard_accounts(name,organization,phone) VALUES('旧负责人','henan','+12025550111') RETURNING id INTO member;
  INSERT INTO dashboard_accounts(name,organization,phone) VALUES('新负责人','henan','+12025550112') RETURNING id INTO second_member;
  INSERT INTO hosting_group_ownership VALUES(conn,'dest',clock_timestamp()-interval '1 year','shanghai_recruitment');
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
  IF (SELECT hosting_group_id FROM dashboard_accounts WHERE id=member) IS NOT NULL OR
     (SELECT hosting_group_id FROM dashboard_accounts WHERE id=second_member) IS DISTINCT FROM 'source'
    THEN RAISE EXCEPTION 'same-tenant owner handoff was not atomic'; END IF;
  opened:=jsonb_build_object('cake_dashboard_account',jsonb_build_object('organization','headquarters','name','新同事',
    'hosting_binding',jsonb_build_object('groupId','empty','previousGroupId',NULL,'previousOwnerId',NULL,'actor',admin_id)));
  INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(auth_id,'12025550113',opened);
  IF NOT EXISTS(SELECT FROM dashboard_accounts WHERE user_id=auth_id AND hosting_group_id='empty')
    THEN RAISE EXCEPTION 'opening did not bind an empty group'; END IF;
  BEGIN
    INSERT INTO auth.users(id,phone,raw_app_meta_data) VALUES(blocked_id,'12025550114',opened);
    RAISE EXCEPTION 'opening despite conflicting selection';
  EXCEPTION WHEN check_violation THEN NULL; END;
  IF EXISTS(SELECT FROM auth.users WHERE id=blocked_id) OR EXISTS(SELECT FROM dashboard_accounts WHERE phone='+12025550114')
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
  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,bots);
  cutoff:=clock_timestamp();
  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id)
    VALUES ('ops-test','ops-between','user','between',cutoff,'new',conn);
  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id,hosting_observed_group_id)
    VALUES ('ops-test','ops-fresh','user','new group verified before sync',cutoff,'new',conn,'dest');
  IF EXISTS(SELECT FROM chat_messages WHERE message_id='ops-fresh' AND tenant_id IS NOT NULL)
    THEN RAISE EXCEPTION 'current group mismatch assigned to old organization'; END IF;

  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
  SELECT * INTO STRICT h FROM hosting_bot_handovers WHERE connection_id=conn AND confirmed_at IS NULL;
  IF h.to_group_id<>'dest' OR (hosting_scope_bindings(conn,ARRAY['source','dest'],ARRAY['new'])->'bots')?'new'
    OR EXISTS(SELECT FROM tenant_visible_chat_messages WHERE message_id='ops-between')
    OR NOT EXISTS(SELECT FROM tenant_visible_chat_messages WHERE message_id='ops-before' AND tenant_id='henan')
    THEN RAISE EXCEPTION 'pending-interval exposure or lost prior history'; END IF;
  BEGIN
    PERFORM confirm_hosting_handover(conn,h.id,'empty',cutoff,admin_id);
    RAISE EXCEPTION 'stale destination confirmed';
  EXCEPTION WHEN check_violation THEN NULL; END;
  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id)
    SELECT 'ops-test','ops-page-'||n,'user','queued during handover',cutoff,'new',conn FROM generate_series(1,315) n;
  PERFORM confirm_hosting_handover(conn,h.id,'dest',cutoff,admin_id);
  PERFORM confirm_hosting_handover(conn,h.id,'dest',cutoff,admin_id);
  IF reconcile_hosting_handover(conn)<>300 OR reconcile_hosting_handover(conn)<>17 OR reconcile_hosting_handover(conn)<>0
    THEN RAISE EXCEPTION 'reconciliation did not resume at same-time message cursor'; END IF;
  IF (SELECT tenant_id FROM chat_messages WHERE message_id='ops-before') IS DISTINCT FROM 'henan' OR
    (SELECT count(*) FROM tenant_visible_chat_messages WHERE message_id IN ('ops-between','ops-fresh') AND tenant_id='shanghai_recruitment')<>2
    THEN RAISE EXCEPTION 'confirmed handover did not reconcile the precise boundary'; END IF;
  IF jsonb_array_length(hosting_management_directory(conn)->'handovers')<>0 THEN RAISE EXCEPTION 'closed review still displayed'; END IF;
  PERFORM sync_hosting_directory(conn,clock_timestamp()-interval '1 minute',groups,bots);
  IF EXISTS(SELECT FROM hosting_bot_handovers WHERE connection_id=conn AND confirmed_at IS NULL)
    THEN RAISE EXCEPTION 'older overlapping response overrode recent scan'; END IF;
  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,'[]');
  PERFORM pg_sleep(0.006);
  PERFORM sync_hosting_directory(conn,clock_timestamp(),groups,moved);
  SELECT * INTO STRICT h FROM hosting_bot_handovers WHERE connection_id=conn AND confirmed_at IS NULL;
  IF h.target_changed_since IS NULL OR h.to_group_id<>h.from_group_id THEN RAISE EXCEPTION 'return after absence was lost'; END IF;
  PERFORM pg_sleep(0.006);
  cutoff:=clock_timestamp();
  PERFORM confirm_hosting_handover(conn,h.id,'dest',cutoff,admin_id);
  IF hosting_tenant_at(conn,'new',NULL,h.detected_at) IS NOT NULL
    OR hosting_tenant_at(conn,'new',NULL,cutoff) IS DISTINCT FROM 'shanghai_recruitment'
    THEN RAISE EXCEPTION 'unobserved absence was assigned across an unknown interval'; END IF;
END $$;
ROLLBACK;
