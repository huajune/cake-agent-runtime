-- Disposable PostgreSQL only; identity, late callbacks and retirement contract.
begin;
set local statement_timeout='5s';
do $$
declare base jsonb; response jsonb; callback jsonb; claimed jsonb; completion jsonb;
begin
  base:=jsonb_build_object('corpId','d-test','accountId','bot','chatId','chat','logicalTurnId','turn-1',
    'inputIds',jsonb_build_array('m1','m2'),'inputOccurredAt',now(),'mode','execute','owner','owner-1','fence',1,
    'deliveryPolicy','single_pass','recovery',jsonb_build_object('primary',jsonb_build_object('chatId','chat')));
  response:=public.transition_agent_reply_turn('open',base||'{"deliveryPolicy":"frozen"}');
  assert response->>'conflict'='primary_single_pass_required';
  response:=public.transition_agent_reply_turn('open',base-'deliveryPolicy');
  assert response->>'conflict'='primary_single_pass_required';
  response:=public.transition_agent_reply_turn('open',base||'{"recovery":{}}');
  assert response->>'conflict'='primary_single_pass_required';
  response:=public.transition_agent_reply_turn('open',base);
  assert response->'turn'->>'logical_turn_id'='turn-1';
  response:=public.transition_agent_reply_turn('open',base||'{"owner":"owner-2","logicalTurnId":"turn-other"}');
  assert response->>'conflict'='ordinary_reply_owned_elsewhere';
  response:=public.transition_agent_reply_turn('save_effects',base||'{"effects":{"toolCalls":[]}}');
  response:=public.transition_agent_reply_turn('project',base);
  response:=public.transition_agent_reply_turn('start_delivery',base);
  response:=public.transition_agent_reply_turn('settle',base||'{"deliveryResult":{"outcome":"unknown","accepted":1,"total":2}}');
  response:=public.transition_agent_reply_turn('ack',base);
  assert response->'turn'->>'status'='acked','input completion is independent from unknown send evidence';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["m2","new-input"],"logicalTurnId":"new-turn","mode":"off"}');
  assert response->'turn'->'input_ids'='["m1","m2"]'::jsonb;
  assert response->'turn'->>'logical_turn_id'='turn-1';
  assert not exists(select 1 from public.agent_reply_inputs where corp_id='d-test' and message_id='new-input');
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,owner,dispatch_attempt_id,fence,attempts,recovery_deadline,review_required)
    select 'd-test','segment-'||n,'bot','chat','turn-1','wecom.reply_segment','resource-'||n,'hash-'||n,'request-'||n,
      jsonb_build_object('parameters',jsonb_build_object('text',case when n=1 then 'one' else 'two' end)),now(),'execute',
      case when n=1 then 'succeeded' else 'unknown' end,'query-owner','dispatch-'||n,3,99,now()-interval '1 day',true from generate_series(1,2) n;
  update public.agent_action_records set status='failed',retryable=false,
    evidence='{"kind":"definitive_no_effect","requestTerminated":true,"detail":"provider_rejected"}'
    where corp_id='d-test' and action_id='segment-2';
  update public.agent_action_records set status='unknown',evidence=null where corp_id='d-test' and action_id='segment-2';
  callback:='{"corpId":"d-test","accountId":"bot","chatId":"chat","requestId":"request-2","messageId":"provider-msg-2","text":"two","messageType":7,"payload":{"text":"two"}}';
  assert not public.append_agent_reply_callback(callback||'{"accountId":"other-bot"}'),'account scope';
  assert not public.append_agent_reply_callback(callback||'{"corpId":"other-corp"}'),'corp scope';
  assert not public.append_agent_reply_callback(callback||'{"chatId":"other-chat"}'),'chat scope';
  assert not public.append_agent_reply_callback(callback||'{"requestId":"other-request"}'),'request identity';
  assert not public.append_agent_reply_callback(callback-'messageType'),'missing type cannot prove text delivery';
  assert not public.append_agent_reply_callback(callback||'{"messageType":9}'),'non-text callback cannot settle a reply';
  assert not public.append_agent_reply_callback(callback||'{"text":"different"}'),'exact payload';
  assert public.append_agent_reply_callback(callback),'late callback accepted after recovery deadline';
  assert public.append_agent_reply_callback(callback),'duplicate callback is idempotent';
  assert (select count(*) from public.agent_action_evidence where corp_id='d-test' and action_id='segment-2')=1,'one evidence row';
  assert (select attempt_id from public.agent_action_evidence where corp_id='d-test' and action_id='segment-2')='dispatch-2','original dispatch attempt, never current query owner';
  assert (select status from public.agent_action_records where corp_id='d-test' and action_id='segment-2')='unknown','callback never overwrites unfenced state';
  claimed:=public.transition_agent_action('reconcile_claim','{"corpId":"d-test","actionId":"segment-2","owner":"reconcile-owner"}');
  select e.completion into completion from public.agent_action_evidence e where corp_id='d-test' and action_id='segment-2';
  response:=public.transition_agent_action('settle',jsonb_build_object('corpId','d-test','actionId','segment-2','owner','reconcile-owner',
    'dispatchAttemptId','dispatch-2','fence',claimed->'record'->'fence','completion',completion,'evidenceHash','fenced-late-success'));
  assert response->'record'->>'status'='succeeded','late evidence settles through current reconciliation fence';
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,owner,dispatch_attempt_id,fence,attempts,recovery_deadline)
    values('d-test','group-mini','bot','group-chat','group-turn','group_task.message','group-resource','group-hash','mini-request',
      '{"parameters":{"messageType":9,"payload":{"appid":"app","username":"mini-user","title":"title","pagePath":"pages/home"}}}',now(),'execute','unknown','q','original-mini-dispatch',2,4,now()+interval '1 day');
  callback:='{"corpId":"d-test","accountId":"bot","chatId":"group-chat","requestId":"mini-request","messageId":"mini-channel-message","messageType":9,"payload":{"appId":"app","username":"mini-user","title":"title","pagePath":"pages/home"}}';
  assert not public.append_agent_reply_callback(callback||jsonb_build_object('payload',(callback->'payload')-'pagePath')),'missing mini path is not terminal proof';
  assert not public.append_agent_reply_callback(callback||jsonb_build_object('payload',(callback->'payload')||'{"appId":"other-app"}')),'mini identity mismatch';
  assert not public.append_agent_reply_callback(callback),'retired group mini callback is rejected';
  update public.agent_action_records set intent='{"parameters":{"messageType":7,"payload":{"text":"group text"}}}'
    where corp_id='d-test' and action_id='group-mini';
  assert not public.append_agent_reply_callback(callback||'{"messageType":7,"text":"group text"}'),'retired group text callback is rejected';
  assert not exists(select 1 from public.agent_action_evidence where corp_id='d-test' and action_id='group-mini'),'retired callbacks create no evidence';

  -- Callback evidence after an ACK never reopens text delivery or reprocesses input.
  assert (select status from public.agent_reply_turns where corp_id='d-test' and logical_turn_id='turn-1')='acked';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["new-input"],"logicalTurnId":"turn-2"}');
  assert response->'turn'->>'logical_turn_id'='turn-2';
  update public.agent_reply_turns set projection_status='pending',updated_at=now()-interval '91 days' where corp_id='d-test' and logical_turn_id='turn-1';
  perform public.redact_completed_agent_reply_turns(100);
  assert exists(select 1 from public.agent_reply_turns where corp_id='d-test' and logical_turn_id='turn-1' and recovery<>'{}'::jsonb);
  response:=public.transition_agent_reply_turn('project',base);
  response:=public.transition_agent_reply_turn('project',base);
  assert response->'turn'->>'projection_status'='complete';
  update public.agent_reply_turns set updated_at=now()-interval '91 days' where corp_id='d-test';
  perform public.redact_completed_agent_reply_turns(100);
  assert exists(select 1 from public.agent_reply_turns where corp_id='d-test' and logical_turn_id='turn-1' and recovery='{}'::jsonb);
  assert exists(select 1 from public.agent_reply_turns where corp_id='d-test' and logical_turn_id='turn-2' and recovery<>'{}'::jsonb),'unacked identity is protected';
  assert (select count(*) from public.agent_reply_inputs where corp_id='d-test' and logical_turn_id='turn-1')=2;
  base:=base||'{"chatId":"task-chat","logicalTurnId":"task-turn","inputIds":["task:old-touch"],"recovery":{"task":{"kind":"reengagement"}}}';
  response:=public.transition_agent_reply_turn('open',base);
  assert response->>'conflict'='scheduled_reply_task_retired';
  assert not exists(select 1 from public.agent_reply_turns where corp_id='d-test' and logical_turn_id='task-turn');
  begin
    perform public.transition_agent_reply_turn('defer_projection',base||'{"chatId":"chat","logicalTurnId":"turn-1"}');
    raise exception 'retired projection operation accepted';
  exception when raise_exception then
    if sqlerrm<>'unknown reply transition' then raise; end if;
  end;
  assert not exists(select 1 from information_schema.columns where table_schema='public' and table_name='agent_reply_turns' and column_name in ('projection_next_check_at','plan'));
  assert to_regprocedure('public.agent_reply_plan_confirmed(text,text)') is null;
  assert to_regclass('public.agent_reply_task_projection_due') is null;
  assert not has_function_privilege('anon','public.append_agent_reply_callback(jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','public.append_agent_reply_callback(jsonb)','EXECUTE');
  assert has_function_privilege('service_role','public.append_agent_reply_callback(jsonb)','EXECUTE');
end $$;
rollback;
