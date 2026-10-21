-- Run only in an isolated database after the action migration. No business data.
begin;
do $$
declare
  p jsonb := jsonb_build_object('corpId','test-corp','actionId','a','requestId','req-a','resourceHash','work-order-1',
    'payloadHash','payload-a','mode','execute','recoveryDeadline',now()+interval '1 day',
    'intent',jsonb_build_object('corpId','test-corp','accountId','account','chatId','chat','logicalTurnId','turn',
    'kind','modify','target','work-order-1','parameters',jsonb_build_object('time','B'),'occurredAt',now()));
  r jsonb;
  c jsonb;
  n integer;
begin
  r:=public.transition_agent_action('prepare',p);
  assert r->'record'->>'status'='registered';
  r:=public.transition_agent_action('prepare',p||'{"payloadHash":"other"}'::jsonb);
  assert r->>'conflict'='identity_payload_mismatch';
  r:=public.transition_agent_action('claim','{"corpId":"test-corp","actionId":"a","owner":"one"}');
  assert r->'record'->>'owner'='one';
  assert (r->'record'->>'fence')::int=1;
  r:=public.transition_agent_action('claim','{"corpId":"test-corp","actionId":"a","owner":"two"}');
  assert r->'record'->>'owner'='one';
  r:=public.transition_agent_action('cancel','{"corpId":"test-corp","actionId":"a"}');
  assert r->'record'->>'status'='executing';
  -- Lease expiry grants only query ownership, never another dispatch.
  update public.agent_action_records set next_check_at=now()-interval '1 second' where action_id='a';
  r:=public.transition_agent_action('reconcile_claim','{"corpId":"test-corp","actionId":"a","owner":"reconciler"}');
  assert r->'record'->>'status'='unknown';
  assert (r->'record'->>'fence')::int=2;
  r:=public.transition_agent_action('claim','{"corpId":"test-corp","actionId":"a","owner":"new-dispatcher"}');
  assert r->'record'->>'owner'='reconciler';
  -- A second modification cannot bypass the unresolved original by changing intent.
  r:=public.transition_agent_action('prepare',p||'{"actionId":"b","requestId":"req-b"}'::jsonb);
  assert r->>'conflict'='a';
  r:=public.transition_agent_action('claim','{"corpId":"test-corp","actionId":"b","owner":"b-owner"}');
  assert r->>'conflict'='a';
  -- Goal satisfaction is not proof that the old request terminated.
  c:='{"status":"succeeded","result":{"time":"B"},"evidence":{"kind":"already_satisfied","goalSatisfied":true,"requestTerminated":false}}';
  r:=public.transition_agent_action('settle',jsonb_build_object('corpId','test-corp','actionId','a','owner','reconciler','fence',2,'evidenceHash','goal','completion',c));
  assert r->'record'->>'status'='unknown';
  c:='{"status":"succeeded","result":{"time":"B"},"evidence":{"kind":"completed","requestTerminated":true}}';
  -- Late writer cannot overwrite the row, but its evidence is retained for recovery.
  r:=public.transition_agent_action('settle',jsonb_build_object('corpId','test-corp','actionId','a','owner','one','fence',1,'evidenceHash','late-success','completion',c));
  assert r->'record'->>'status'='unknown';
  select count(*) into n from public.agent_action_evidence where action_id='a' and evidence_hash='late-success'; assert n=1;
  r:=public.transition_agent_action('settle',jsonb_build_object('corpId','test-corp','actionId','a','owner','reconciler','fence',2,'evidenceHash','confirmed','completion',c));
  assert r->'record'->>'status'='succeeded';
  assert r->'record'->>'local_sync'='pending';
  -- Late failure cannot turn a completed external action into failure.
  c:='{"status":"failed","retryable":true,"evidence":{"kind":"definitive_no_effect","requestTerminated":true}}';
  r:=public.transition_agent_action('settle',jsonb_build_object('corpId','test-corp','actionId','a','owner','one','fence',1,'evidenceHash','late-failure','completion',c));
  assert r->'record'->>'status'='succeeded';
  r:=public.transition_agent_action('synced','{"corpId":"test-corp","actionId":"a","owner":"one","fence":1}');
  assert r->'record'->>'local_sync'='pending';
  r:=public.transition_agent_action('synced','{"corpId":"test-corp","actionId":"a","owner":"reconciler","fence":2}');
  assert r->'record'->>'local_sync'='complete';
  -- An undispatched cancellation is terminal and cannot be revived.
  r:=public.transition_agent_action('cancel','{"corpId":"test-corp","actionId":"b"}'); assert r->'record'->>'status'='cancelled';
  r:=public.transition_agent_action('claim','{"corpId":"test-corp","actionId":"b","owner":"again"}'); assert r->'record'->>'status'='cancelled';
  -- Ordinary retention strips completed payloads but keeps terminal identity.
  update public.agent_action_records set updated_at=now()-interval '91 days' where action_id='a';
  perform public.redact_completed_agent_actions(100);
  select count(*) into n from public.agent_action_records where action_id='a' and status='succeeded' and not(intent ? 'parameters'); assert n=1;
  assert not has_table_privilege('anon','public.agent_action_records','select');
  assert not has_function_privilege('authenticated','public.transition_agent_action(text,jsonb)','execute');
end $$;
-- New lawful intents form an audit chain; this is never a substitute for business permission.
do $$
declare
  p jsonb := jsonb_build_object('corpId','lineage-corp','resourceHash','work-order-42',
    'mode','execute','recoveryDeadline',now()+interval '1 day',
    'intent',jsonb_build_object('corpId','lineage-corp','accountId','account','chatId','chat',
      'kind','sponge.modify','target','work-order-42','occurredAt',now()));
  r jsonb;
  replay jsonb;
  i integer;
begin
  -- A -> B -> A are different validated intentions, with distinct identities.
  for i in 1..3 loop
    p:=p||jsonb_build_object('actionId','lineage-'||i,'requestId','req-'||i,'payloadHash',case when i=2 then 'B' else 'A' end);
    p:=jsonb_set(p,'{intent,logicalTurnId}',to_jsonb('turn-'||i));
    p:=jsonb_set(p,'{intent,parameters}',jsonb_build_object('newInterviewTime',case when i=2 then 'B' else 'A' end));
    r:=public.transition_agent_action('prepare',p);
    assert (r->>'conflict') is null;
    assert r->'record'->>'previous_action_id' is not distinct from case when i=1 then null else 'lineage-'||(i-1) end;
    if i=2 then replay:=p; end if;
    perform public.transition_agent_action('claim',jsonb_build_object('corpId','lineage-corp','actionId','lineage-'||i,'owner','attempt-'||i));
    perform public.transition_agent_action('settle',jsonb_build_object('corpId','lineage-corp','actionId','lineage-'||i,'owner','attempt-'||i,'fence',1,'evidenceHash','done',
      'completion',jsonb_build_object('status','succeeded','result',jsonb_build_object('workOrderId',42),
        'evidence',jsonb_build_object('kind','completed','requestTerminated',true))));
    perform public.transition_agent_action('synced',jsonb_build_object('corpId','lineage-corp','actionId','lineage-'||i,'owner','attempt-'||i,'fence',1));
  end loop;
  -- Neither replay nor a mismatching request may rewrite immutable ancestry or create a cycle.
  r:=public.transition_agent_action('prepare',replay);
  assert r->'record'->>'previous_action_id'='lineage-1';
  r:=public.transition_agent_action('prepare',replay||'{"payloadHash":"mismatch"}'::jsonb);
  assert r->>'conflict'='identity_payload_mismatch' and r->'record'->>'previous_action_id'='lineage-1';
  -- Even identical synthetic resource/action IDs cannot cross the enterprise boundary.
  r:=public.transition_agent_action('prepare',jsonb_set(p||'{"corpId":"lineage-other-corp"}'::jsonb,'{intent,corpId}','"lineage-other-corp"'));
  assert (r->'record'->>'previous_action_id') is null;
  -- Cancellation shares the same work-order resource across kinds and actual accounts.
  p:=p||'{"actionId":"lineage-4","requestId":"req-4","payloadHash":"cancel"}'::jsonb;
  p:=jsonb_set(jsonb_set(p,'{intent,kind}','"sponge.cancel"'),'{intent,accountId}','"other-account"');
  r:=public.transition_agent_action('prepare',p);
  assert r->'record'->>'previous_action_id'='lineage-3' and (r->>'conflict') is null;
  perform public.transition_agent_action('claim','{"corpId":"lineage-corp","actionId":"lineage-4","owner":"unresolved"}');
  r:=public.transition_agent_action('prepare',p||'{"actionId":"lineage-5","requestId":"req-5"}'::jsonb);
  assert r->'record'->>'previous_action_id'='lineage-4' and r->>'conflict'='lineage-4';
  r:=public.transition_agent_action('claim','{"corpId":"lineage-corp","actionId":"lineage-5","owner":"must-not-dispatch"}');
  assert r->>'conflict'='lineage-4' and r->'record'->>'status'='registered';
  -- Rebooking follows the phone/job booking chain, not unrelated work-order mutations.
  p:=p||'{"actionId":"booking-old","requestId":"book-old","resourceHash":"booking-phone-job","payloadHash":"book"}'::jsonb;
  p:=jsonb_set(jsonb_set(p,'{intent,kind}','"sponge.booking"'),'{intent,target}','"booking-phone-job"');
  r:=public.transition_agent_action('prepare',p);
  assert (r->'record'->>'previous_action_id') is null;
  perform public.transition_agent_action('cancel','{"corpId":"lineage-corp","actionId":"booking-old"}');
  r:=public.transition_agent_action('prepare',p||'{"actionId":"booking-new","requestId":"book-new"}'::jsonb);
  assert r->'record'->>'previous_action_id'='booking-old' and (r->>'conflict') is null;
  -- Redaction preserves the complete ancestry even after the predecessor result/body is gone.
  update public.agent_action_records set updated_at=now()-interval '91 days'
    where corp_id='lineage-corp' and action_id in ('lineage-1','lineage-2','lineage-3');
  perform public.redact_completed_agent_actions(100);
  assert (select previous_action_id='lineage-2' and retention_redacted and result is null
    from public.agent_action_records where corp_id='lineage-corp' and action_id='lineage-3');
  r:=public.transition_agent_action('prepare',replay);
  assert r->'record'->>'previous_action_id'='lineage-1';
end $$;
rollback;
