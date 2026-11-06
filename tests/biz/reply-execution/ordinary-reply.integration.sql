-- Local PostgreSQL only. Assert the contract independently from TypeScript constants.
begin;
set local statement_timeout='5s';
do $$
declare base jsonb; r jsonb; stored jsonb;
begin
  base:=jsonb_build_object('corpId','single-pass-test','accountId','bot','chatId','chat','logicalTurnId','ordinary-1',
    'inputIds',jsonb_build_array('m1','m2'),'inputOccurredAt',now(),'mode','execute','owner','owner-1','fence',1,
    'deliveryPolicy','single_pass','recovery',jsonb_build_object('primary',jsonb_build_object('chatId','chat')));
  r:=public.transition_agent_reply_turn('open',base);
  assert r->'turn'->>'delivery_policy'='single_pass';
  assert r->'turn'->>'plan' is null;
  r:=public.transition_agent_reply_turn('open',base||'{"owner":"other","logicalTurnId":"other"}');
  assert r->>'conflict'='ordinary_reply_owned_elsewhere','concurrent input cannot get a second generator';
  r:=public.transition_agent_reply_turn('plan',base||'{"plan":{"text":"must not freeze"}}');
  assert r->>'conflict'='ordinary_reply_plan_forbidden';
  r:=public.transition_agent_reply_turn('check_input',base-'fence');
  assert r->>'conflict'='ordinary_reply_fence_lost','missing fence cannot authorize a tool';
  r:=public.transition_agent_reply_turn('check_input',base);
  assert r->>'conflict' is null;
  r:=public.transition_agent_reply_turn('start_delivery',base||'{"owner":"other"}');
  assert r->>'conflict'='ordinary_reply_fence_lost';
  r:=public.transition_agent_reply_turn('save_effects',base||'{"effects":{"workOrderId":123}}');
  assert r->'turn'->>'projection_status'='pending';
  r:=public.transition_agent_reply_turn('save_effects',base||'{"effects":{"workOrderId":456}}');
  assert r->>'conflict'='immutable_business_effects';
  r:=public.transition_agent_reply_turn('start_delivery',base);
  assert r->'turn'->>'status'='planned' and r->'turn'->>'plan' is null;
  r:=public.transition_agent_reply_turn('check_delivery',base);
  assert r->>'conflict' is null;
  r:=public.transition_agent_reply_turn('interrupt',base);
  assert r->>'conflict'='ordinary_reply_still_owned';
  r:=public.transition_agent_reply_turn('settle',base||'{"deliveryResult":{"outcome":"unknown","accepted":1,"total":3}}');
  assert r->'turn'->>'status'='settled','unknown stops this text but does not claim send success';
  stored:=r->'turn'->'delivery_result';
  r:=public.transition_agent_reply_turn('ack',base);
  assert r->>'conflict'='business_effects_pending','booking follow-up must still be handed off';
  r:=public.transition_agent_reply_turn('project',base);
  r:=public.transition_agent_reply_turn('ack',base);
  assert r->'turn'->>'status'='acked';
  r:=public.transition_agent_reply_turn('check_delivery',base);
  assert r->>'conflict'='ordinary_reply_fence_lost','stale worker cannot continue after closure';
  r:=public.transition_agent_reply_turn('settle',base||'{"deliveryResult":{"outcome":"complete","accepted":3,"total":3}}');
  assert r->'turn'->'delivery_result'=stored,'late old completion cannot overwrite a terminal result';
  r:=public.transition_agent_reply_turn('open',base||'{"inputIds":["m2","m3"],"logicalTurnId":"other","mode":"observe"}');
  assert r->'turn'->>'logical_turn_id'='ordinary-1';
  assert r->'turn'->'input_ids'='["m1","m2"]'::jsonb,'partial ACK must never consume m3';
  r:=public.transition_agent_reply_turn('open',base||'{"inputIds":["m3"],"logicalTurnId":"ordinary-2"}');
  assert r->'turn'->>'logical_turn_id'='ordinary-2','new input continues after unknown ordinary text';
  r:=public.transition_agent_reply_turn('start_delivery',base||'{"logicalTurnId":"ordinary-2"}');
  update public.agent_reply_turns set generation_until=now()-interval '1 second' where corp_id='single-pass-test' and logical_turn_id='ordinary-2';
  r:=public.transition_agent_reply_turn('interrupt',base||'{"logicalTurnId":"ordinary-2"}');
  assert r->'turn'->>'status'='settled';
  assert r->'turn'->'delivery_result'='{"outcome":"interrupted"}'::jsonb,'crash does not invent sent counts';
  r:=public.transition_agent_reply_turn('check_delivery',base||'{"logicalTurnId":"ordinary-2"}');
  assert r->>'conflict'='ordinary_reply_fence_lost';
  begin
    update public.agent_reply_turns set delivery_result='{"outcome":"complete"}' where corp_id='single-pass-test';
    raise exception 'malformed delivery result passed';
  exception when check_violation then null; end;
  assert not has_function_privilege('anon','public.transition_agent_reply_turn(text,jsonb)','EXECUTE');
  assert not has_function_privilege('authenticated','public.transition_agent_reply_turn(text,jsonb)','EXECUTE');
end $$;
rollback;
