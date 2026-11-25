-- Disposable database with the full migration chain. Every fixture rolls back.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout='8s';
SET LOCAL lock_timeout='1s';
SET LOCAL ROLE service_role;
INSERT INTO public.system_config(key,value) VALUES ('runtime_storage_writes',
  '{"chat_text":true,"action_body":true,"steps":true,"response_tools":true}')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;

DO $$
DECLARE c public.chat_messages; f record;
BEGIN
  INSERT INTO public.chat_messages(message_id,chat_id,content,role,timestamp,message_type,payload,payload_text_v1)
    VALUES ('batch-chat','synthetic','hello','user',now(),'TEXT','{"text":"hello","extra":3}',-1) RETURNING * INTO c;
  ASSERT c.payload_text_v1 IS NULL AND c.payload->>'text'='hello', 'mixed format must opt in';
  UPDATE public.system_config SET value=value||'{"chat_mixed_text":true}' WHERE key='runtime_storage_writes';
  FOR f IN SELECT * FROM (VALUES
    ('hello','{"text":"hello","pureText":"hello","extra":{"nested":[2,null]}}'::jsonb,3),
    ('hello','{"text":null,"pureText":"hello","id":1}',2),
    ('hello','{"text":"hello","pureText":"different"}',1),
    ('','{"pureText":"","extra":null}',2),
    ('42','{"text":42,"pureText":"42"}',2),
    ('hello','{"text":"hello"}',1),
    ('hello','{"pureText":null}',NULL),('hello','{}',NULL),('hello','null',NULL),
    ('hello','[]',NULL),('hello',NULL,NULL)
  ) v(content,body,mask) LOOP
    -- Make the content change separately; even clients patching text alone must
    -- preserve the old payload until they explicitly replace it.
    UPDATE public.chat_messages SET content=f.content WHERE message_id='batch-chat';
    UPDATE public.chat_messages SET payload=f.body,payload_text_v1=-1 WHERE message_id='batch-chat' RETURNING * INTO c;
    ASSERT c.payload_text_v1 IS NOT DISTINCT FROM f.mask;
    ASSERT public.chat_read_payload(c) IS NOT DISTINCT FROM f.body;
    ASSERT (f.mask IS NULL) OR public.chat_body_storage_state(c)='already_referenced';
    UPDATE public.chat_messages SET content='edited' WHERE message_id='batch-chat' RETURNING * INTO c;
    ASSERT c.payload_text_v1 IS NULL AND public.chat_read_payload(c) IS NOT DISTINCT FROM f.body;
  END LOOP;
  UPDATE public.chat_messages SET content='both',payload='{"text":"both","x":1}',payload_text_v1=-1
    WHERE message_id='batch-chat' RETURNING * INTO c;
  ASSERT c.payload_text_v1 IS NULL AND public.chat_read_payload(c)='{"text":"both","x":1}';
  UPDATE public.chat_messages SET message_type='IMAGE',payload='{"text":"both"}',payload_text_v1=-1
    WHERE message_id='batch-chat' RETURNING * INTO c;
  ASSERT public.chat_body_storage_state(c)='keep_other_message_type';
  UPDATE public.chat_messages SET message_type='TEXT',payload='{"text":"both","duration":2}',payload_text_v1=-1
    WHERE message_id='batch-chat' RETURNING * INTO c;
  ASSERT c.payload_text_v1=1;
  UPDATE public.chat_messages SET message_type='VOICE' WHERE message_id='batch-chat' RETURNING * INTO c;
  ASSERT c.payload_text_v1 IS NULL AND public.center_chat_media_payload(c.payload,c.message_type)='{"text":"both","duration":2}';
END $$;

DO $$
DECLARE
  p jsonb := jsonb_build_object('corpId','batch-corp','requestId','req','resourceHash','resource',
    'payloadHash','payload','mode','execute','recoveryDeadline',now()+interval '1 day',
    'intent',jsonb_build_object('accountId','bot','chatId','chat','logicalTurnId','turn',
      'kind','wecom.group_add_member','target','group','parameters','{}'::jsonb,'occurredAt',now()));
  own jsonb;
  completion jsonb := '{"status":"failed","result":{"accepted":false,"error":"room not found"},
    "evidence":{"kind":"definitive_no_effect","requestTerminated":true}}';
  item text;
  body jsonb;
  got jsonb;
  a public.agent_action_records;
BEGIN
  FOREACH item IN ARRAY ARRAY['off','failed','retry','conflict','partial','unknown','different'] LOOP
    p:=p||jsonb_build_object('actionId',item,'requestId','request-'||item,'resourceHash','resource-'||item);
    own:=jsonb_build_object('corpId','batch-corp','actionId',item,'owner','dispatch','dispatchAttemptId','dispatch','fence',1);
    PERFORM public.transition_agent_action('prepare',p);
    PERFORM public.transition_agent_action('claim',own);
    IF item<>'off' THEN UPDATE public.system_config SET value=value||'{"action_failed_body":true}' WHERE key='runtime_storage_writes'; END IF;
    body:=completion;
    IF item='retry' THEN body:=body||'{"retryable":true}'; END IF;
    IF item='partial' THEN body:=body-'result'; END IF;
    IF item='unknown' THEN body:=jsonb_set(body,'{evidence,requestTerminated}','false'); END IF;
    IF item='conflict' THEN
      PERFORM public.transition_agent_action('settle',own||jsonb_build_object('owner','stale','completion',
        '{"status":"succeeded","result":{},"evidence":{"kind":"completed","requestTerminated":true}}'::jsonb));
    END IF;
    got:=public.transition_agent_action('settle',own||jsonb_build_object('completion',body));
    SELECT * INTO STRICT a FROM public.agent_action_records WHERE corp_id='batch-corp' AND action_id=item;
    IF item IN ('failed','partial','different') THEN
      ASSERT a.body_ref_v1 AND a.result IS NULL AND a.evidence IS NULL;
      ASSERT got->'record'->'result' IS NOT DISTINCT FROM coalesce(body->'result','null'::jsonb);
      ASSERT got->'record'->'evidence'=completion->'evidence';
      ASSERT public.action_body_storage_state(a)='already_referenced';
    ELSIF item='off' THEN
      ASSERT a.body_ref_v1 IS NULL AND a.evidence=completion->'evidence' AND public.action_body_storage_state(a)='eligible';
      a.accepted_evidence_hash:=NULL;
      ASSERT public.action_body_storage_state(a)='unknown_accepted_identity';
    ELSE
      ASSERT a.body_ref_v1 IS NOT TRUE AND public.action_body_storage_state(a)=
        CASE item WHEN 'conflict' THEN 'keep_conflicting_receipts' WHEN 'retry' THEN 'keep_retryable' ELSE 'keep_unknown' END;
    END IF;
    IF item='different' THEN
      a.body_ref_v1:=NULL; a.result:='"different"'; a.evidence:=body->'evidence';
      ASSERT public.action_body_storage_state(a)='keep_different_body';
      a.body_ref_v1:=true; a.result:=NULL; a.evidence:=NULL; a.accepted_evidence_hash:='not-the-accepted-receipt';
      ASSERT public.action_body_storage_state(a)='broken_reference';
    END IF;
  END LOOP;
END $$;

DO $$
DECLARE
  age integer;
  r jsonb;
  c jsonb := '[{"name":"find","args":{"i":1},"result":"1"},{"name":"find","args":{"i":1},"error":"retry"}]';
  steps jsonb := jsonb_build_array(jsonb_build_object('toolCalls',jsonb_build_array(c->0)),
    jsonb_build_object('toolCalls',jsonb_build_array(c->1)));
  inbound text := repeat('🌍问',38)||chr(10)||'second merged message';
  outbound text := repeat('答🌍',85);
  snapshot jsonb := jsonb_build_object('request',jsonb_build_object('userInput',inbound),
    'response',jsonb_build_object('reply',jsonb_build_object('content',outbound),
      'messages',jsonb_build_array('segment one','segment two'),'toolCalls',c));
  listed jsonb;
  detailed jsonb;
BEGIN
  FOREACH age IN ARRAY ARRAY[89,90,91] LOOP
    r:=jsonb_build_object('message_id','batch-age-'||age,'chat_id','chat','bot_im_id','batch-bot',
      'status','success','received_at',now(),'tool_calls',c,'agent_steps',steps,
      'message_preview',inbound,'reply_preview',outbound,'reply_segments',2);
    PERFORM public.save_processing_snapshot(r,snapshot);
    UPDATE public.message_processing_invocations SET created_at=now()-make_interval(days=>age) WHERE message_id=r->>'message_id';
  END LOOP;
  ASSERT public.delete_expired_agent_invocations()=1;
  ASSERT (SELECT count(*)=2 AND bool_and(public.processing_read_invocation(i)=snapshot)
    FROM public.message_processing_invocations i WHERE message_id IN ('batch-age-89','batch-age-90'));
  ASSERT (SELECT public.processing_read_steps(m)=steps AND reply_preview=outbound
    AND length(public.processing_list_message_preview(m))=50 AND length(public.processing_list_reply_preview(m))=120
    FROM public.message_processing_records m WHERE message_id='batch-age-91');
  listed:=public.center_dashboard_processing_read('slowest',ARRAY['batch-bot'],current_date-1,current_date+1,'{}');
  ASSERT jsonb_array_length(listed)=3 AND listed->0->>'replyPreview'=left(outbound,120);
  detailed:=public.center_dashboard_processing_read('processing-detail',ARRAY['batch-bot'],current_date-1,current_date+1,'{"id":"batch-age-91"}');
  ASSERT detailed->>'replyPreview'=outbound AND detailed->>'messagePreview'=inbound AND detailed->>'replySegments'='2';
  ASSERT public.center_dashboard_processing_read('processing-detail',ARRAY['other-bot'],current_date-1,current_date+1,'{"id":"batch-age-91"}') IS NULL;
  UPDATE public.message_processing_records SET tool_calls=jsonb_build_array(c->1,c->0) WHERE message_id='batch-age-90';
  ASSERT (SELECT public.processing_read_invocation(i) IS NULL AND superseded_invocation=snapshot
    FROM public.message_processing_invocations i WHERE message_id='batch-age-90');
  ASSERT (SELECT public.processing_read_steps(m)=steps FROM public.message_processing_records m WHERE message_id='batch-age-90');
  PERFORM public.save_processing_snapshot(r||'{"message_id":"batch-fallback","reply_preview":"guard fallback","is_fallback":true}',NULL);
  ASSERT (SELECT reply_preview='guard fallback' AND public.processing_list_reply_preview(m)='guard fallback'
    FROM public.message_processing_records m WHERE message_id='batch-fallback');
END $$;

-- A different corporate account or an unaccepted attempt cannot block a repair.
DO $$
DECLARE answer jsonb;
BEGIN
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
    resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,status,
    dispatch_attempt_id,accepted_attempt_id,accepted_evidence_hash,body_ref_v1)
    VALUES ('batch-corp','booking','bot','chat','turn','sponge.modify','resource','payload','order-req','{}',
      now(),'execute',now()+interval '1 day','succeeded','dispatch','dispatch','accepted',true);
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion) VALUES
    ('batch-corp','booking','dispatch','accepted','{"status":"succeeded","result":{"workOrderId":101}}'),
    ('batch-corp','booking','dispatch','other','{"status":"succeeded","result":{"workOrderId":102}}'),
    ('batch-corp','booking','other-dispatch','accepted','{"status":"succeeded","result":{"workOrderId":103}}');
  answer:=public.apply_active_booking_projection('batch-corp','user','clear',101,now()-interval '1 hour');
  ASSERT answer->>'superseded'='true';
  answer:=public.apply_active_booking_projection('batch-corp','user','clear',102,now()-interval '1 hour');
  ASSERT answer->>'superseded'='false';
  answer:=public.apply_active_booking_projection('batch-corp','user','clear',103,now()-interval '1 hour');
  ASSERT answer->>'superseded'='false';
  answer:=public.apply_active_booking_projection('other-corp','user','clear',101,now()-interval '1 hour');
  ASSERT answer->>'superseded'='false';
END $$;

-- The tenant rollout has a separate reader and booking RPC. Exercise both when installed.
RESET ROLE;
DO $$
BEGIN
  IF to_regprocedure('public.tenant_dashboard_processing_read(text,text,date,date,jsonb)') IS NULL THEN RETURN; END IF;
  INSERT INTO public.hosting_group_ownership(connection_id,group_id,effective_from,tenant_id)
    VALUES('stride-primary','batch-group',now()-interval '2 days','henan');
  INSERT INTO public.hosting_bot_memberships(connection_id,bot_im_id,effective_from,group_id)
    VALUES('stride-primary','batch-bot',now()-interval '2 days','batch-group'),
          ('stride-primary','bot',now()-interval '2 days','batch-group');
END $$;
SET LOCAL ROLE service_role;
DO $$
DECLARE d jsonb;
BEGIN
  IF to_regprocedure('public.tenant_dashboard_processing_read(text,text,date,date,jsonb)') IS NULL THEN RETURN; END IF;
  UPDATE public.message_processing_records SET source_occurred_at=now() WHERE message_id='batch-age-91';
  d:=public.tenant_dashboard_processing_read('slowest','henan',current_date-1,current_date+1,'{}');
  ASSERT length(d->0->>'messagePreview')=50 AND length(d->0->>'replyPreview')=120;
  d:=public.tenant_dashboard_processing_read('processing-detail','henan',current_date-1,current_date+1,'{"id":"batch-age-91"}');
  ASSERT length(d->>'replyPreview')=170;
  ASSERT public.tenant_dashboard_processing_read('processing-detail','shanghai_recruitment',current_date-1,current_date+1,
    '{"id":"batch-age-91"}') IS NULL;
  d:=public.tenant_apply_active_booking_projection('henan','batch-corp','user','clear',101,now()-interval '1 hour');
  ASSERT d->>'superseded'='true';
  d:=public.tenant_apply_active_booking_projection('shanghai_recruitment','batch-corp','user','clear',101,now()-interval '1 hour');
  ASSERT d->>'superseded'='false';
END $$;
ROLLBACK;
