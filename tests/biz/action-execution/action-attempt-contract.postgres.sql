-- Real SQL: dispatch attempt identity cannot be inferred from a reconciliation owner.
begin;
set local statement_timeout='5s';
do $$
declare base jsonb; r jsonb; completion jsonb; invalid jsonb; n integer;
begin
  base:='{"corpId":"attempt-test","actionId":"a","owner":"attempt-A","fence":1,"dispatchAttemptId":"attempt-A"}';
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,owner,dispatch_attempt_id,fence,next_check_at,recovery_deadline)
    values('attempt-test','a','bot','chat','turn','wecom.reply_segment','resource','hash','request','{}',now(),'execute','executing','attempt-A','attempt-A',1,now()+interval '10 minutes',now()+interval '1 day');
  completion:='{"status":"succeeded","evidence":{"kind":"accepted","requestTerminated":true}}';
  r:=public.transition_agent_action('validate_claim',base); assert r->'record'->>'action_id'='a';
  r:=public.transition_agent_action('validate_claim',base-'fence'); assert r->'record'='null'::jsonb;
  r:=public.transition_agent_action('validate_claim',base-'dispatchAttemptId'); assert r->'record'='null'::jsonb;
  for invalid in select value from jsonb_array_elements('[null,"", "   ",42,{},[]]') loop
    begin
      perform public.transition_agent_action('settle',base||jsonb_build_object('dispatchAttemptId',invalid,'completion',completion,'evidenceHash','invalid'));
      raise exception 'invalid attempt accepted';
    exception when raise_exception then
      if sqlerrm<>'original_dispatch_attempt_required' then raise; end if;
    end;
  end loop;
  begin
    perform public.transition_agent_action('settle',(base-'dispatchAttemptId')||jsonb_build_object('completion',completion,'evidenceHash','missing'));
    raise exception 'missing attempt accepted';
  exception when raise_exception then
    if sqlerrm<>'original_dispatch_attempt_required' then raise; end if;
  end;
  assert not exists(select 1 from public.agent_action_evidence where corp_id='attempt-test');
  assert (select status from public.agent_action_records where corp_id='attempt-test' and action_id='a')='executing';
  -- Explicit definitive no-effect evidence permits a separate dispatch attempt B.
  r:=public.transition_agent_action('settle',base||jsonb_build_object('evidenceHash','A-failed','completion',
    '{"status":"failed","retryable":true,"evidence":{"kind":"definitive_no_effect","requestTerminated":true}}'::jsonb));
  r:=public.transition_agent_action('claim',base||'{"owner":"attempt-B"}');
  assert r->'record'->>'dispatch_attempt_id'='attempt-B';
  assert r->'record'->>'fence'='2';
  -- Even the current owner/fence may not apply attempt A's late evidence to B.
  r:=public.transition_agent_action('settle',base||jsonb_build_object('owner','attempt-B','fence',2,'evidenceHash','A-late','completion',completion));
  assert r->>'conflict'='dispatch_attempt_mismatch' and r->'record'='null'::jsonb;
  assert exists(select 1 from public.agent_action_evidence where corp_id='attempt-test' and attempt_id='attempt-A' and evidence_hash='A-late');
  assert (select status='executing' and dispatch_attempt_id='attempt-B' and owner='attempt-B' and fence=2 from public.agent_action_records where corp_id='attempt-test' and action_id='a');
  update public.agent_action_records set next_check_at=now()-interval '1 second' where corp_id='attempt-test';
  r:=public.transition_agent_action('reconcile_claim',base||'{"owner":"query-owner"}');
  assert r->'record'->>'dispatch_attempt_id'='attempt-B' and r->'record'->>'fence'='3';
  -- Same-attempt evidence from the lost writer remains recoverable without overwriting the current fence.
  r:=public.transition_agent_action('settle',base||jsonb_build_object('owner','attempt-B','fence',2,'dispatchAttemptId','attempt-B','evidenceHash','B-late','completion',completion));
  assert r->'record'->>'status'='unknown';
  r:=public.transition_agent_action('settle',base||jsonb_build_object('owner','query-owner','fence',3,'dispatchAttemptId','attempt-B','evidenceHash','B-reconciled','completion',completion));
  assert r->'record'->>'status'='succeeded' and r->'record'->>'local_sync'='pending';
  assert not has_function_privilege('anon','public.transition_agent_action(text,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','public.transition_agent_action(text,jsonb)','EXECUTE');
  assert has_function_privilege('service_role','public.transition_agent_action(text,jsonb)','EXECUTE');
end $$;
rollback;
