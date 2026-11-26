-- Run after the full migration chain in a disposable database.
BEGIN;
SET LOCAL ROLE service_role;
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
    PERFORM public.save_processing_snapshot(r,snapshot->'request',snapshot->'response');
    UPDATE public.message_processing_turn_snapshots SET created_at=now()-make_interval(days=>age) WHERE message_id=r->>'message_id';
  END LOOP;
  ASSERT public.delete_expired_agent_invocations()=1;
  ASSERT (SELECT count(*)=2 AND bool_and(request=snapshot->'request' AND response=(snapshot->'response')-'toolCalls')
    FROM public.message_processing_turn_snapshots i WHERE message_id IN ('batch-age-89','batch-age-90'));
  ASSERT (SELECT m.agent_steps='[{},{}]' AND reply_preview=outbound
    AND length(public.processing_list_message_preview(m))=50 AND length(public.processing_list_reply_preview(m))=120
    FROM public.message_processing_records m WHERE message_id='batch-age-91');
  listed:=public.center_dashboard_processing_read('slowest',ARRAY['batch-bot'],current_date-1,current_date+1,'{}');
  ASSERT jsonb_array_length(listed)=3 AND listed->0->>'replyPreview'=left(outbound,120);
  detailed:=public.center_dashboard_processing_read('processing-detail',ARRAY['batch-bot'],current_date-1,current_date+1,'{"id":"batch-age-91"}');
  ASSERT detailed->>'replyPreview'=outbound AND detailed->>'messagePreview'=inbound AND detailed->>'replySegments'='2';
  ASSERT public.center_dashboard_processing_read('processing-detail',ARRAY['other-bot'],current_date-1,current_date+1,'{"id":"batch-age-91"}') IS NULL;
  UPDATE public.message_processing_records SET tool_calls=jsonb_build_array(c->1,c->0) WHERE message_id='batch-age-90';
  ASSERT NOT EXISTS (SELECT FROM public.message_processing_turn_snapshots WHERE message_id='batch-age-90');
  ASSERT (SELECT m.agent_steps='[{},{}]' FROM public.message_processing_records m WHERE message_id='batch-age-90');
  PERFORM public.save_processing_snapshot(r||'{"message_id":"batch-fallback","reply_preview":"guard fallback","is_fallback":true}',NULL,NULL);
  ASSERT (SELECT reply_preview='guard fallback' AND public.processing_list_reply_preview(m)='guard fallback'
    FROM public.message_processing_records m WHERE message_id='batch-fallback');
END $$;

-- A different corporate account or an unaccepted attempt cannot block a repair.
DO $$
DECLARE answer jsonb;
BEGIN
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
    resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,recovery_deadline,status,
    dispatch_attempt_id,result)
    VALUES ('batch-corp','booking','bot','chat','turn','sponge.modify','resource','payload','order-req','{}',
      now(),'execute',now()+interval '1 day','succeeded','dispatch','{"workOrderId":101}');
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
  ASSERT d->>'replyPreview'=repeat('答🌍',85);
  ASSERT public.tenant_dashboard_processing_read('processing-detail','shanghai_recruitment',current_date-1,current_date+1,
    '{"id":"batch-age-91"}') IS NULL;
  d:=public.tenant_apply_active_booking_projection('henan','batch-corp','user','clear',101,now()-interval '1 hour');
  ASSERT d->>'superseded'='true';
  d:=public.tenant_apply_active_booking_projection('shanghai_recruitment','batch-corp','user','clear',101,now()-interval '1 hour');
  ASSERT d->>'superseded'='false';
END $$;
ROLLBACK;
