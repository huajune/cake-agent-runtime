-- Run against a disposable PostgreSQL after 20261021090000 + 20261021100000.
-- No provider calls. Rollback leaves the test database unchanged.
begin;
do $$
declare base jsonb; response jsonb; plan jsonb; action jsonb; callback jsonb; claimed jsonb; completion jsonb;
begin
  base:=jsonb_build_object('corpId','d-test','accountId','bot','chatId','chat','logicalTurnId','turn-1',
    'inputIds',jsonb_build_array('m1','m2'),'inputOccurredAt',now(),'mode','execute','owner','owner-1');
  response:=public.transition_agent_reply_turn('open',base);
  assert response->'turn'->>'logical_turn_id'='turn-1','initial input membership';
  response:=public.transition_agent_reply_turn('open',base||'{"owner":"owner-2","logicalTurnId":"turn-other"}');
  assert response->>'conflict'='generation_owned_elsewhere','one generation lease';
  plan:='{"version":1,"text":"one two","segments":[{"index":0,"text":"one","actionId":"segment-1","requestId":"request-1"},{"index":1,"text":"two","actionId":"segment-2","requestId":"request-2"}]}';
  response:=public.transition_agent_reply_turn('plan',base||jsonb_build_object('fence',1,'plan',plan));
  assert response->'turn'->>'status'='planned','immutable plan persisted';
  response:=public.transition_agent_reply_turn('plan',base||jsonb_build_object('fence',1,'plan',plan||'{"text":"different"}'));
  assert response->>'conflict'='immutable_reply_plan','cannot reuse same identity for different text';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["m2","new-input"],"logicalTurnId":"new-turn","mode":"off"}');
  assert response->'turn'->'input_ids'='["m1","m2"]'::jsonb,'partial ack and regrouping preserve every original input';
  assert response->'turn'->>'logical_turn_id'='turn-1','off cannot bypass old execute turn';
  assert not exists(select 1 from public.agent_reply_inputs where corp_id='d-test' and message_id='new-input'),'new input not swallowed by old plan';
  response:=public.transition_agent_reply_turn('settle',base);
  assert response->>'conflict'='unresolved_reply_segments','cannot ack missing segments';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["task:follow-up"],"logicalTurnId":"task-new","recovery":{"task":{"kind":"reengagement"}}}');
  assert response->>'conflict'='different_reply_intent_pending','proactive task cannot borrow an ordinary reply plan';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["unrelated-direct-input"],"logicalTurnId":"direct-new"}');
  assert response->>'conflict'='different_reply_intent_pending','direct input cannot borrow an unrelated plan';


  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,owner,dispatch_attempt_id,fence,attempts,recovery_deadline,review_required)
    select 'd-test','segment-'||n,'bot','chat','turn-1','wecom.reply_segment','resource-'||n,'hash-'||n,'request-'||n,
      jsonb_build_object('parameters',jsonb_build_object('text',case when n=1 then 'one' else 'two' end)),now(),'execute',
      case when n=1 then 'succeeded' else 'unknown' end,'query-owner','dispatch-'||n,3,99,now()-interval '1 day',true from generate_series(1,2) n;
  assert not public.agent_reply_plan_confirmed('d-test','turn-1'),'one confirmed does not imply complete reply';
  response:=public.transition_agent_reply_turn('settle',base);
  assert response->>'conflict'='unresolved_reply_segments','unknown second segment cannot ack whole input';
  update public.agent_action_records set status='failed',retryable=false,
    evidence='{"kind":"definitive_no_effect","requestTerminated":true,"detail":"provider_rejected"}'
    where corp_id='d-test' and action_id='segment-2';
  response:=public.transition_agent_reply_turn('settle',base);
  assert response->>'conflict'='unresolved_reply_segments','provider definitive failure is not a completed reply';
  assert not public.agent_reply_plan_confirmed('d-test','turn-1'),'provider failure is not delivered';
  update public.agent_action_records set status='unknown',evidence=null where corp_id='d-test' and action_id='segment-2';
  callback:='{"corpId":"d-test","accountId":"bot","chatId":"chat","requestId":"request-2","messageId":"provider-msg-2","text":"two","messageType":7,"payload":{"text":"two"}}';
  assert not public.append_agent_reply_callback(callback||'{"accountId":"other-bot"}'),'account scope';
  assert not public.append_agent_reply_callback(callback||'{"corpId":"other-corp"}'),'corp scope';
  assert not public.append_agent_reply_callback(callback||'{"text":"different"}'),'exact payload';
  assert public.append_agent_reply_callback(callback),'late callback accepted after recovery deadline';
  assert public.append_agent_reply_callback(callback),'duplicate callback is idempotent';
  assert (select count(*) from public.agent_action_evidence where corp_id='d-test' and action_id='segment-2')=1,'one evidence row';
  assert (select attempt_id from public.agent_action_evidence where corp_id='d-test' and action_id='segment-2')='dispatch-2','original dispatch attempt, never current query owner';
  assert (select status from public.agent_action_records where corp_id='d-test' and action_id='segment-2')='unknown','callback never overwrites unfenced state';
  claimed:=public.transition_agent_action('reconcile_claim','{"corpId":"d-test","actionId":"segment-2","owner":"reconcile-owner"}');
  select e.completion into completion from public.agent_action_evidence e where corp_id='d-test' and action_id='segment-2';
  response:=public.transition_agent_action('settle',jsonb_build_object('corpId','d-test','actionId','segment-2','owner','reconcile-owner',
    'fence',claimed->'record'->'fence','completion',completion,'evidenceHash','fenced-late-success'));
  assert response->'record'->>'status'='succeeded','late evidence settles through current reconciliation fence';
  assert public.agent_reply_plan_confirmed('d-test','turn-1'),'only terminal segment evidence completes delivery';
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,owner,dispatch_attempt_id,fence,attempts,recovery_deadline)
    values('d-test','group-mini','bot','group-chat','group-turn','group_task.message','group-resource','group-hash','mini-request',
      '{"parameters":{"messageType":9,"payload":{"appid":"app","username":"mini-user","title":"title","pagePath":"pages/home"}}}',now(),'execute','unknown','q','original-mini-dispatch',2,4,now()+interval '1 day');
  callback:='{"corpId":"d-test","accountId":"bot","chatId":"group-chat","requestId":"mini-request","messageId":"mini-channel-message","messageType":9,"payload":{"appId":"app","username":"mini-user","title":"title","pagePath":"pages/home"}}';
  assert not public.append_agent_reply_callback(callback||jsonb_build_object('payload',(callback->'payload')-'pagePath')),'missing mini path is not terminal proof';
  assert not public.append_agent_reply_callback(callback||jsonb_build_object('payload',(callback->'payload')||'{"appId":"other-app"}')),'mini identity mismatch';
  assert public.append_agent_reply_callback(callback),'exact mini callback is retained for group handler';

  response:=public.transition_agent_reply_turn('settle',base);
  assert response->'turn'->>'status'='settled','durable conclusion precedes queue ack';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["m2","new-input"],"mode":"off"}');
  assert response->'turn'->>'status'='settled','ack failure restores ack-only state';
  response:=public.transition_agent_reply_turn('ack',base);
  response:=public.transition_agent_reply_turn('defer',base);
  assert response->'turn'->>'status'='acked','defer is harmless after recovery acknowledgement';
  response:=public.transition_agent_reply_turn('ack',base);
  assert response->'turn'->>'status'='acked','ack is repeatable';
  response:=public.transition_agent_reply_turn('open',base||'{"inputIds":["new-input"],"logicalTurnId":"turn-2"}');
  assert response->'turn'->>'logical_turn_id'='turn-2','new input gets a new plan';
  response:=public.transition_agent_reply_turn('plan',base||jsonb_build_object('logicalTurnId','turn-2','fence',1,'plan',plan));
  update public.agent_action_records set logical_turn_id='turn-2',status='cancelled' where corp_id='d-test' and action_id='segment-1';
  update public.agent_action_records set logical_turn_id='turn-2',status='failed',retryable=false,
    evidence='{"kind":"definitive_no_effect","requestTerminated":true,"detail":"permission_changed_before_dispatch"}'
    where corp_id='d-test' and action_id='segment-2';
  assert not public.agent_reply_plan_confirmed('d-test','turn-2'),'local cancellation is not delivered';
  response:=public.transition_agent_reply_turn('settle',base||'{"logicalTurnId":"turn-2"}');
  assert response->'turn'->>'status'='settled','confirmed local no-dispatch permission cancellation completes input only';
  update public.agent_reply_turns set updated_at=now()-interval '91 days' where corp_id='d-test' and logical_turn_id='turn-1';
  perform public.redact_completed_agent_reply_turns(100);
  assert exists(select 1 from public.agent_reply_turns t where t.corp_id='d-test' and t.logical_turn_id='turn-1' and t.plan is null),'completed payload redacted';
  assert (select count(*) from public.agent_reply_inputs where corp_id='d-test' and logical_turn_id='turn-1')=2,'membership tombstone remains';

  base:=base||jsonb_build_object('chatId','task-chat','logicalTurnId','task-turn','inputIds',jsonb_build_array('task:old-touch'),
    'inputOccurredAt',now()-interval '4 days','recovery','{"task":{"kind":"reengagement","data":{"jobData":{"workOrderId":42},"batchId":"original-trace","sentAt":1782266400000}}}'::jsonb);
  response:=public.transition_agent_reply_turn('open',base);
  assert response->'turn'->>'projection_status'='pending','task repair admitted durably before any send';
  plan:='{"version":1,"text":"original task text","segments":[{"index":0,"text":"original task text","actionId":"task-segment","requestId":"task-request"}]}';
  response:=public.transition_agent_reply_turn('plan',base||jsonb_build_object('fence',1,'plan',plan));
  insert into public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,recovery_deadline)
    values('d-test','task-segment','bot','task-chat','task-turn','wecom.reply_segment','task-resource','task-hash','task-request','{"parameters":{"text":"original task text"}}',now()-interval '4 days','execute','succeeded',now()-interval '3 days');
  response:=public.transition_agent_reply_turn('settle',base);
  response:=public.transition_agent_reply_turn('ack',base);
  update public.agent_reply_turns set updated_at=now()-interval '91 days',projection_next_check_at=now()-interval '1 minute' where corp_id='d-test' and logical_turn_id='task-turn';
  perform public.redact_completed_agent_reply_turns(100);
  assert exists(select 1 from public.agent_reply_turns t where t.logical_turn_id='task-turn' and t.recovery->'task' is not null and t.plan is not null),'pending local repair is never redacted after ack or Redis expiry';
  assert exists(select 1 from public.agent_reply_turns where logical_turn_id='task-turn' and projection_status='pending' and projection_next_check_at<=now()),'confirmed task remains indexed until projection completes';
  response:=public.transition_agent_reply_turn('project',base);
  assert response->'turn'->>'projection_status'='complete','projection completion is separate from delivery ack';
  response:=public.transition_agent_reply_turn('project',base);
  assert response->'turn'->>'projection_status'='complete','projection completion is idempotent';
end $$;
rollback;

begin;
do $$
declare response jsonb;
begin
 response:=public.transition_agent_reply_turn('open',jsonb_build_object('corpId','observe-test','accountId','bot','chatId','chat','logicalTurnId','observe','inputIds',jsonb_build_array('input'),'inputOccurredAt',now(),'mode','observe','recovery',jsonb_build_object('primary','private input')));
 assert response->'turn'='null'::jsonb;
 assert not exists(select 1 from public.agent_reply_turns where corp_id='observe-test');
end $$;
rollback;
