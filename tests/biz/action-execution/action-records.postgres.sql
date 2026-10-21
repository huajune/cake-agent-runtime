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
rollback;
