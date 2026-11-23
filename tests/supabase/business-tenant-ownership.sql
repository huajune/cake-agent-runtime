-- Run on a migrated testing database. All identities, events, counts and bindings roll back.
BEGIN;
DO $test$
DECLARE
  supplier text;
  at_henan timestamptz := '2026-11-21 09:00+08';
  at_supplier timestamptz := '2026-11-21 15:00+08';
  reports jsonb;
  bot constant text := 'qa-tenant-transfer-bot';
  session constant text := 'qa-shared-session';
  corp constant text := 'qa-shared-corp';
  group_a constant text := 'qa-business-before';
  group_b constant text := 'qa-business-after';
BEGIN
  INSERT INTO tenants(name) VALUES('验收供应商') RETURNING id INTO supplier;
  PERFORM import_dashboard_staff_roster(jsonb_build_array(jsonb_build_object('name','测试同事',
    'organization',supplier,'hosting_group_id',group_b)),false);
  IF NOT EXISTS (SELECT FROM dashboard_accounts WHERE organization=supplier AND hosting_group_id=group_b)
    OR NOT (hosting_management_directory('stride-primary')->'tenants' @> jsonb_build_array(jsonb_build_object('id',supplier,'name','验收供应商')))
    THEN RAISE EXCEPTION 'new tenant unavailable for onboarding'; END IF;
  INSERT INTO hosting_group_ownership(connection_id,group_id,effective_from,tenant_id)
    VALUES('stride-primary',group_a,at_henan,'henan'),('stride-primary',group_b,at_henan,supplier);
  INSERT INTO hosting_bot_memberships(connection_id,bot_im_id,effective_from,group_id)
    VALUES('stride-primary',bot,at_henan,group_a),('stride-primary',bot,at_supplier,group_b);

  INSERT INTO chat_messages(chat_id,message_id,role,content,timestamp,im_bot_id,hosting_connection_id)
    VALUES(session,'qa-dec-before','user','before',at_henan,bot,'stride-primary'),
      (session,'qa-dec-after','user','after',at_supplier,bot,'stride-primary');
  IF hosting_event_tenants('stride-primary',jsonb_build_array(
    jsonb_build_object('bot',bot,'at',at_henan,'message_id','qa-dec-before'),
    jsonb_build_object('bot',bot,'at',at_supplier,'message_id','qa-dec-after'),
    jsonb_build_object('bot','qa-unknown','at',at_henan))) IS DISTINCT FROM jsonb_build_array('henan',supplier,NULL)
    THEN RAISE EXCEPTION 'wrong original ownership for merged inputs'; END IF;

  INSERT INTO agent_execution_events(trace_id,event_type) VALUES('qa-dec-trace','start');
  INSERT INTO guardrail_review_records(trace_id,first_reply,first_decision,final_decision)
    VALUES('qa-dec-trace','fixture','pass','pass');
  PERFORM save_processing_snapshot(jsonb_build_object('message_id','qa-dec-trace','chat_id',session,
    'batch_id','qa-dec-trace','scenario','reengagement:opening_no_reply',
    'received_at',at_supplier,'source_occurred_at',at_henan,'status','success','bot_im_id',bot),'{"fixture":true}');
  INSERT INTO agent_execution_events(trace_id,event_type) VALUES('qa-dec-trace','end');
  PERFORM save_processing_snapshot(jsonb_build_object('message_id','qa-dec-trace','chat_id',session,
    'received_at',at_supplier,'source_occurred_at',at_supplier,'status','success','bot_im_id',bot),NULL);
  IF EXISTS (SELECT FROM agent_execution_events WHERE trace_id='qa-dec-trace' AND tenant_id IS DISTINCT FROM 'henan')
    OR (SELECT tenant_id FROM guardrail_review_records WHERE trace_id='qa-dec-trace') IS DISTINCT FROM 'henan'
    OR (SELECT tenant_id FROM message_processing_invocations WHERE message_id='qa-dec-trace') IS DISTINCT FROM 'henan'
    OR (SELECT tenant_id FROM message_processing_records WHERE message_id='qa-dec-trace') IS DISTINCT FROM 'henan'
    THEN RAISE EXCEPTION 'processing retry, invocation or out-of-order child has incorrect owner'; END IF;

  INSERT INTO reengagement_touch_records(touch_key,session_id,scenario_code,anchor_at,created_at,status,bot_im_id,batch_id)
    VALUES('qa-dec-touch',session,'opening_no_reply',at_henan,at_supplier,'sent',bot,'qa-dec-trace');
  UPDATE reengagement_touch_records SET anchor_at=at_supplier WHERE touch_key='qa-dec-touch';
  IF NOT EXISTS (SELECT FROM reengagement_touch_records t JOIN message_processing_records p ON p.message_id=t.batch_id
    WHERE t.touch_key='qa-dec-touch' AND p.tenant_id=t.tenant_id AND p.source_occurred_at=t.anchor_at
      AND p.received_at>t.anchor_at)
    THEN RAISE EXCEPTION 'proactive turn must inherit the trigger event time even when processed after a handover'; END IF;
  INSERT INTO handoff_events(chat_id,corp_id,reason_code,idempotency_key,created_at,bot_im_id)
    VALUES(session,corp,'other','qa-dec-handoff',at_supplier,bot);
  IF (SELECT tenant_id FROM handoff_events WHERE idempotency_key='qa-dec-handoff') IS DISTINCT FROM supplier
    OR (SELECT tenant_id FROM reengagement_touch_records WHERE touch_key='qa-dec-touch') IS DISTINCT FROM 'henan'
    THEN RAISE EXCEPTION 'touch or handoff inherited the wrong tenant'; END IF;

  PERFORM upsert_ops_event(corp,'candidate.message_received','first',at_henan,bot,p_chat_id=>session);
  PERFORM upsert_ops_event(corp,'candidate.message_received','second',at_supplier,bot,p_chat_id=>session);
  PERFORM upsert_ops_event(corp,'candidate.message_received','first',at_supplier,bot,p_chat_id=>session);
  PERFORM record_user_activity('qa-tenant-intake',session,NULL,NULL,1,0,at_henan,NULL,bot);
  PERFORM record_user_activity('qa-tenant-intake',session,NULL,NULL,1,0,at_supplier,NULL,bot);
  PERFORM upsert_user_activity(session,p_active_at=>at_supplier,p_im_bot_id=>bot);
  IF (SELECT count(*) FROM daily_ops_report WHERE corp_id=corp AND candidate_message_count=1 AND tenant_id IN ('henan',supplier))<>2
    OR (SELECT count(*) FROM user_activity WHERE chat_id=session AND message_count=1 AND tenant_id IN ('henan',supplier))<>2
    OR (SELECT tenant_id FROM ops_events WHERE corp_id=corp AND idempotency_key='first') IS DISTINCT FROM 'henan'
    THEN RAISE EXCEPTION 'same-day transfer or duplicate event contaminated aggregate'; END IF;

  IF tenant_dashboard_read('processing-detail',supplier,'2026-11-21','2026-11-21','{"id":"qa-dec-trace"}') IS NOT NULL
    OR tenant_dashboard_read('touch-detail',supplier,'2026-11-21','2026-11-21','{"touchKey":"qa-dec-touch"}') IS NOT NULL
    OR tenant_dashboard_read('processing-detail','henan','2026-11-21','2026-11-21','{"id":"qa-dec-trace"}')->>'messageId' IS DISTINCT FROM 'qa-dec-trace'
    OR tenant_dashboard_read('touch-detail','henan','2026-11-21','2026-11-21','{"touchKey":"qa-dec-touch"}')->>'touch_key' IS DISTINCT FROM 'qa-dec-touch'
    THEN RAISE EXCEPTION 'scoped detail visibility failed'; END IF;
  reports:=tenant_dashboard_read('business-trend',supplier,'2026-11-21','2026-11-21','{}');
  IF reports->'trend'->0->>'messageCount' IS DISTINCT FROM '1'
    OR tenant_dashboard_read('users',supplier,'2026-11-21','2026-11-21','{}')->'users'->0->>'messageCount' IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'tenant report includes other owner'; END IF;
  UPDATE tenants SET name='供应商新名称' WHERE id=supplier;
  IF NOT (hosting_scope_bindings('stride-primary',ARRAY[group_b],ARRAY[bot])->'tenantNames' @> jsonb_build_object(supplier,'供应商新名称'))
    OR hosting_feishu_route('stride-primary',bot,at_supplier) IS NOT NULL
    THEN RAISE EXCEPTION 'renamed supplier or optional integration failure'; END IF;

  PERFORM tenant_upsert_long_term_profile_facts('henan',corp,'person','stable-bot','{}','{"fixture":"A"}');
  PERFORM tenant_upsert_long_term_profile_facts(supplier,corp,'person','stable-bot','{}','{"fixture":"B"}');
  PERFORM tenant_apply_active_booking_projection('henan',corp,'person','set',111,at_henan);
  PERFORM tenant_apply_active_booking_projection(supplier,corp,'person','set',222,at_supplier);
  PERFORM tenant_apply_active_booking_projection(supplier,corp,'person','clear',222,at_supplier+interval '1 minute');
  IF (SELECT count(*) FROM agent_long_term_memories WHERE corp_id=corp AND bot_user_id='stable-bot' AND tenant_id IN ('henan',supplier))<>2
    OR (SELECT active_booking->'bookings'->0->>'work_order_id' FROM agent_long_term_memories WHERE corp_id=corp AND tenant_id='henan' AND bot_user_id IS NULL) IS DISTINCT FROM '111'
    THEN RAISE EXCEPTION 'memory profile or booking crossed tenants'; END IF;
  -- A move is discovered after noon. Previously stamped facts are hidden at
  -- detection and corrected when the effective time is confirmed.
  INSERT INTO message_processing_records(message_id,chat_id,bot_im_id,received_at,source_occurred_at,status)
    VALUES('qa-dec-late',session,bot,at_henan+interval '3 hours',at_henan+interval '3 hours','success');
  PERFORM upsert_ops_event(corp,'agent.replied','late',at_henan+interval '3 hours',bot,p_chat_id=>session);
  PERFORM record_user_activity('qa-late-act',session,NULL,NULL,1,5,at_henan+interval '3 hours',NULL,bot);
  INSERT INTO hosting_bot_handovers(connection_id,bot_im_id,from_group_id,to_group_id,review_from,detected_at,target_changed_since)
    VALUES('stride-primary',bot,group_a,group_b,at_henan+interval '1 hour',at_henan+interval '4 hours',at_henan+interval '4 hours');
  IF EXISTS(SELECT FROM tenant_visible_message_processing_records WHERE message_id='qa-dec-late') THEN
    RAISE EXCEPTION 'unconfirmed transfer exposed mixed facts'; END IF;
  INSERT INTO hosting_bot_memberships VALUES('stride-primary',bot,at_henan+interval '2 hours',group_b);
  UPDATE hosting_bot_handovers SET effective_at=at_henan+interval '2 hours',confirmed_at=at_henan+interval '5 hours'
    WHERE bot_im_id=bot AND connection_id='stride-primary' AND confirmed_at IS NULL;
  IF reconcile_business_handover('stride-primary')<3 OR reconcile_business_handover('stride-primary')<>0
    THEN RAISE EXCEPTION 'bounded transfer repair lost facts or repeated a correction'; END IF;
  IF (SELECT tenant_id FROM tenant_visible_message_processing_records WHERE message_id='qa-dec-late') IS DISTINCT FROM supplier
    OR (SELECT agent_reply_count FROM daily_ops_report WHERE corp_id=corp AND tenant_id=supplier) IS DISTINCT FROM 1
    OR (SELECT agent_reply_count FROM daily_ops_report WHERE corp_id=corp AND tenant_id='henan') IS DISTINCT FROM 0
    OR (SELECT token_usage FROM user_activity WHERE chat_id=session AND tenant_id=supplier) IS DISTINCT FROM 5
    OR (SELECT message_count FROM user_activity WHERE chat_id=session AND tenant_id='henan') IS DISTINCT FROM 1
    THEN RAISE EXCEPTION 'retroactive correction did not move the right counters'; END IF;
  IF has_table_privilege('authenticated','public.chat_messages','SELECT') OR has_table_privilege('anon','public.message_processing_records','SELECT')
    OR has_function_privilege('authenticated','public.tenant_dashboard_read(text,text,date,date,jsonb)','EXECUTE')
    OR has_function_privilege('anon','public.tenant_upsert_long_term_profile_facts(text,text,text,text,jsonb,jsonb,jsonb)','EXECUTE')
    THEN RAISE EXCEPTION 'private RPC accessible outside API'; END IF;
END $test$;
ROLLBACK;
