begin;
do $$
declare
  scope jsonb:='{"corpId":"five","accountId":"bot","chatId":"chat","logicalTurnId":"r","owner":"live","fence":1}';
  request jsonb:=scope||jsonb_build_object('inputIds',array['input'],'inputOccurredAt',now()-interval '1 hour',
    'mode','execute','deliveryPolicy','single_pass','recovery','{"primary":{}}'::jsonb);
  plan jsonb:='{"segments":["address","hours"],"effects":{"toolCalls":[],"context":{"corpId":"five","chatId":"chat","logicalTurnId":"r"}}}';
  action jsonb:='{"corpId":"five","owner":"sender","actionId":"a","requestId":"stable","resourceHash":"resource","payloadHash":"payload","mode":"execute",
    "intent":{"kind":"wecom.reply_segment","corpId":"five","accountId":"bot","chatId":"chat","logicalTurnId":"r",
    "intentId":"r:reply:v1:0","target":"chat:chat:reply:r:segment:0","parameters":{"text":"address","index":0,"version":1}}}';
  r jsonb; cutoff timestamptz;
begin
  assert not has_function_privilege('anon','public.transition_agent_reply_segment(text,jsonb,jsonb)','execute');
  assert not has_function_privilege('authenticated','public.transition_agent_reply_segment(text,jsonb,jsonb)','execute');
  perform public.transition_agent_reply_turn('open',request);
  perform public.transition_agent_reply_turn('save_reply',scope||plan);
  r:=public.transition_agent_reply_turn('start_delivery',scope);
  assert (r#>>'{turn,recovery,resumeUntil}')::timestamptz=now()+interval '5 minutes','window starts with live activity, not input age';
  assert (r#>>'{turn,generation_until}')::timestamptz=now()+interval '3 minutes';
  update agent_reply_turns set recovery=jsonb_set(recovery,'{resumeUntil}',to_jsonb(now()+interval '10 seconds')) where corp_id='five';
  r:=public.transition_agent_reply_turn('renew',scope);
  assert (r#>>'{turn,recovery,resumeUntil}')::timestamptz=now()+interval '5 minutes','only a live original heartbeat refreshes the window';
  update agent_reply_turns set recovery_attempts=6,next_check_at=now() where corp_id='five';
  r:=public.transition_agent_reply_turn('defer',scope);
  assert r#>>'{turn,next_check_at}'=r#>>'{turn,generation_until}',
    'an early callback or restarted scanner cannot back off past the first takeover opportunity';
  cutoff:=clock_timestamp()+interval '1 second';
  update agent_reply_turns set generation_until=now()-interval '1 second',recovery=jsonb_set(recovery,'{resumeUntil}',to_jsonb(cutoff)) where corp_id='five';
  r:=public.transition_agent_reply_turn('resume_delivery',scope||'{"newOwner":"recovered"}');
  assert r#>>'{turn,status}'='planned' and (r#>>'{turn,recovery,resumeUntil}')::timestamptz=cutoff;
  action:=action||jsonb_build_object('recoveryDeadline',now()+interval '23 hours');
  r:=public.transition_agent_reply_segment('claim',action,scope);
  assert r->>'conflict'='ordinary_reply_fence_lost','superseded worker cannot register a send';
  scope:=scope||'{"owner":"recovered","fence":2}';
  r:=public.transition_agent_reply_segment('claim',jsonb_set(action,'{intent,parameters,text}','"changed"'),scope);
  assert r->>'conflict'='identity_payload_mismatch';
  r:=public.transition_agent_reply_segment('inspect',action,scope);
  assert r='{"record":null}'::jsonb and not exists(select from agent_action_records where corp_id='five');
  r:=public.transition_agent_reply_segment('claim',action,scope);
  assert (r->>'dispatchUntil')::timestamptz=cutoff,'the grant carries the earliest deadline';
  assert r#>>'{record,status}'='executing' and r#>>'{record,dispatch_attempt_id}'='sender' and (r#>>'{record,attempts}')::integer=1;
  r:=public.transition_agent_reply_segment('claim',action||'{"owner":"competitor"}',scope);
  assert r#>>'{record,owner}'='sender' and (r#>>'{record,attempts}')::integer=1;
  action:=action||'{"fence":1,"dispatchAttemptId":"sender"}';
  r:=public.transition_agent_reply_segment('claim',action,scope);
  assert not (r ? 'dispatchUntil'),'repeating the grant request cannot authorize a second HTTP call';
  r:=public.transition_agent_reply_segment('inspect',action,scope);
  assert r#>>'{record,status}'='executing' and not (r ? 'dispatchUntil');
  r:=public.transition_agent_reply_turn('renew',scope);
  assert (r#>>'{turn,recovery,resumeUntil}')::timestamptz=cutoff;
  r:=public.transition_agent_reply_turn('defer',scope);
  assert (r#>>'{turn,next_check_at}')::timestamptz<=cutoff,'retry cannot start a new five-minute window';
  update agent_reply_turns set recovery=jsonb_set(recovery,'{resumeUntil}',to_jsonb(clock_timestamp()-interval '1 millisecond')) where corp_id='five';
  r:=public.transition_agent_reply_segment('claim',action,scope);
  assert r->>'conflict'='ordinary_reply_fence_lost','an expired recovery cannot claim';
  r:=public.transition_agent_reply_turn('check_delivery',scope);
  assert r->>'conflict'='ordinary_reply_fence_lost','older dispatchers respect the same cutoff';
  r:=public.transition_agent_reply_turn('resume_delivery',scope||'{"newOwner":"late"}');
  assert r#>>'{turn,status}'='settled','an unexpired recovery lease cannot extend external dispatch';

  -- An older checkpoint with text but no trustworthy activity time cannot gain a fresh window.
  scope:=scope||'{"logicalTurnId":"legacy","chatId":"legacy-chat","owner":"live","fence":1}';
  perform public.transition_agent_reply_turn('open',request||scope||'{"inputIds":["legacy-input"]}');
  plan:=jsonb_set(plan,'{effects,context}',jsonb_build_object('corpId','five','chatId','legacy-chat','logicalTurnId','legacy'));
  perform public.transition_agent_reply_turn('save_reply',scope||plan);
  update agent_reply_turns set generation_until=now()-interval '1 second',recovery=recovery-'resumeUntil'
    where corp_id='five' and logical_turn_id='legacy';
  r:=public.transition_agent_reply_turn('resume_delivery',scope||'{"newOwner":"restart"}');
  assert r#>>'{turn,status}'='settled' and r#>>'{turn,delivery_result,outcome}'='skipped'
    and (r#>>'{turn,delivery_result,accepted}')::integer=0,'legacy checkpoint grants no new delivery';
end $$;
rollback;
