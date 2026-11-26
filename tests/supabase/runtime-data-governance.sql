-- Run after the complete migration chain in a disposable PostgreSQL database.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';

CREATE FUNCTION pg_temp.reject_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'injected child failure'; END $$;
CREATE TRIGGER fail_one_snapshot BEFORE INSERT OR UPDATE ON public.message_processing_turn_snapshots
  FOR EACH ROW WHEN (NEW.message_id='gov-fail') EXECUTE FUNCTION pg_temp.reject_snapshot();

CREATE TRIGGER fail_one_handoff BEFORE INSERT ON public.handoff_events
  FOR EACH ROW WHEN (NEW.idempotency_key='reject-ticket') EXECUTE FUNCTION pg_temp.reject_snapshot();

SET LOCAL ROLE service_role;
-- Per-exchange bodies are immutable, independent of the tool projection and never exposed to anon/authenticated.
DO $model_calls$
DECLARE
  r jsonb := jsonb_build_object('message_id','gov-wire','chat_id','fixture','received_at',now(),'status','success');
  call1 jsonb := jsonb_build_object('id',gen_random_uuid(),'provider','qwen','startedAt',now()-interval '91 days',
    'httpStatus',503,'complete',true,'requestBody','e30=','responseBody','/wA=');
  call2 jsonb := call1 || jsonb_build_object('id',gen_random_uuid(),'startedAt',now(),'provider','deepseek',
    'httpStatus',null,'complete',false,'responseBody',null);
  calls jsonb := jsonb_build_array(call1,call2);
BEGIN
  ASSERT public.save_processing_snapshot(r,'{}','{"reply":"fallback"}',calls);
  ASSERT public.save_processing_snapshot(r,'{}','{"reply":"fallback"}',calls);
  UPDATE public.message_processing_records SET tool_calls='[]' WHERE message_id='gov-wire';
  ASSERT (SELECT count(*)=2 FROM public.message_processing_invocations WHERE message_id='gov-wire');
  ASSERT (SELECT encode(request_body,'hex')='7b7d' AND encode(response_body,'hex')='ff00' AND complete
    FROM public.message_processing_invocations WHERE id=(call1->>'id')::uuid);
  ASSERT (SELECT response_body IS NULL AND http_status IS NULL AND NOT complete FROM public.message_processing_invocations WHERE id=(call2->>'id')::uuid);
  BEGIN
    PERFORM public.save_processing_snapshot(r||'{"message_id":"gov-wire-invalid"}','{}','{}',
      jsonb_build_array(call1||'{"requestBody":"*"}'));
    RAISE EXCEPTION 'invalid bytes should roll back the entire write';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
  ASSERT NOT EXISTS (SELECT FROM public.message_processing_records WHERE message_id='gov-wire-invalid');
  ASSERT public.delete_expired_agent_invocations(90,1)=1;
  ASSERT (SELECT count(*)=1 AND bool_and(id=(call2->>'id')::uuid) FROM public.message_processing_invocations WHERE message_id='gov-wire');
  UPDATE public.message_processing_records SET chat_id='corrected' WHERE message_id='gov-wire';
  ASSERT NOT EXISTS (SELECT FROM public.message_processing_invocations WHERE message_id='gov-wire');
  ASSERT NOT has_table_privilege('anon','public.message_processing_invocations','SELECT');
  ASSERT NOT has_table_privilege('authenticated','public.message_processing_invocations','SELECT');
  ASSERT NOT has_table_privilege('service_role','public.message_processing_invocations','UPDATE');
END $model_calls$;

DO $$
DECLARE
  r jsonb := '{"message_id":"gov-message","chat_id":"gov-chat","received_at":"2026-11-18T10:00:00Z","status":"success"}';
  calls jsonb := '[{"toolName":"lookup","toolCallId":"first","args":{"n":1}},{"toolName":"lookup","toolCallId":"second","result":"retry"}]';
  steps jsonb; req jsonb; resp jsonb; forbidden boolean:=false;
BEGIN
  steps := jsonb_build_array(jsonb_build_object('stepIndex',0,'toolCalls',jsonb_build_array(calls->0)),jsonb_build_object('stepIndex',0,'toolCalls',jsonb_build_array(calls->1)));
  r := r || jsonb_build_object('agent_steps',steps,'tool_calls',calls);
  req := '{"agentRequest":{"messages":[{"role":"user","content":"hello"}],"instructions":"full request","toolDefinitions":[{"name":"lookup"}]}}';
  resp := jsonb_build_object('reply','saved','toolCalls',calls);
  ASSERT public.save_processing_snapshot(r,req,resp);
  ASSERT (SELECT request=req AND response=resp-'toolCalls' AND
    public.processing_request_context(i)='{"agentRequest":{"messages":[{"role":"user","content":"hello"}]}}'
    FROM public.message_processing_turn_snapshots i WHERE message_id='gov-message');
  ASSERT (SELECT agent_steps='[{"stepIndex":0},{"stepIndex":0}]' AND tool_calls->0->'stepPosition'='0'
    AND tool_calls->1->'stepPosition'='1' FROM public.message_processing_records WHERE message_id='gov-message');
  ASSERT public.save_processing_snapshot(r-'tool_calls',NULL,NULL);
  ASSERT (SELECT tool_calls->0->'stepPosition'='0' AND tool_calls->1->'stepPosition'='1'
    AND (tool_calls->0)-'stepPosition'=calls->0 AND (tool_calls->1)-'stepPosition'=calls->1
    FROM public.message_processing_records WHERE message_id='gov-message');
  BEGIN PERFORM public.save_processing_snapshot(r||'{"message_id":"gov-fail"}',req,resp);
    RAISE EXCEPTION 'missing injected failure';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'injected child failure' THEN RAISE; END IF; END;
  ASSERT NOT EXISTS (SELECT FROM public.message_processing_records WHERE message_id='gov-fail');
  UPDATE public.message_processing_records SET status='timeout' WHERE message_id='gov-message';
  ASSERT EXISTS (SELECT FROM public.message_processing_turn_snapshots WHERE message_id='gov-message');
  UPDATE public.message_processing_records SET tool_calls='[]' WHERE message_id='gov-message';
  ASSERT NOT EXISTS (SELECT FROM public.message_processing_turn_snapshots WHERE message_id='gov-message');
  ASSERT public.save_processing_snapshot(r,req,resp);
  INSERT INTO public.chat_messages(message_id,chat_id,role,content,timestamp,message_type,payload)
    VALUES('gov-chat','a','user','hello',now(),'TEXT','{"text":"hello","other":"original"}');
  UPDATE public.chat_messages SET content='corrected' WHERE message_id='gov-chat';
  ASSERT (SELECT payload='{"text":"hello","other":"original"}' FROM public.chat_messages WHERE message_id='gov-chat');
  INSERT INTO public.test_executions(id,test_input,actual_output,agent_response)
    VALUES('00000000-0000-4000-a000-000000000001','{}','hello','{"text":"hello","tools":[1]}');
  UPDATE public.test_executions SET actual_output='different' WHERE id='00000000-0000-4000-a000-000000000001';
  ASSERT (SELECT agent_response->>'text'='hello' FROM public.test_executions WHERE id='00000000-0000-4000-a000-000000000001');
  ASSERT has_table_privilege('service_role','agent_action_reviews','SELECT');
  ASSERT NOT has_table_privilege('service_role','agent_action_reviews','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  BEGIN DELETE FROM public.agent_action_reviews WHERE false;
  EXCEPTION WHEN insufficient_privilege THEN forbidden:=true; END;
  ASSERT forbidden;
  ASSERT NOT has_table_privilege('anon','message_processing_turn_snapshots','SELECT');
  ASSERT NOT has_function_privilege('authenticated','public.save_processing_snapshot(jsonb,jsonb,jsonb,jsonb)','EXECUTE');
END $$;

DO $$
DECLARE ticket jsonb := jsonb_build_object('corp_id','gov-a','bot_im_id','bot-a','chat_id','shared',
  'idempotency_key','fact-1','reason_code','other','reason','original','created_at',now()-interval '1 minute');
  p jsonb := jsonb_build_object('corpId','gov','actionId','act','requestId','external-unchanged','resourceHash','target',
    'payloadHash','frozen','mode','execute','recoveryDeadline',now()+interval '1 day',
    'intent',jsonb_build_object('corpId','gov','accountId','bot','chatId','chat','logicalTurnId','turn',
      'kind','booking','target','target','parameters','{}'::jsonb,'occurredAt',now()));
  c jsonb := '{"status":"succeeded","result":{"workOrderId":42},"evidence":{"kind":"completed","requestTerminated":true}}';
  own jsonb := '{"corpId":"gov","actionId":"act","owner":"dispatch","dispatchAttemptId":"dispatch","fence":1}'; result jsonb;
BEGIN
  ASSERT public.record_handoff(ticket,'agent_tool',NULL,NULL)='inserted';
  ASSERT public.record_handoff(ticket||'{"reason":"changed on retry"}','other',NULL,NULL)='duplicate';
  ASSERT public.record_handoff(ticket||'{"bot_im_id":"wrong-account"}','agent_tool',NULL,NULL)='scope_conflict';
  ASSERT (SELECT handoff_count=1 FROM public.daily_ops_report WHERE corp_id='gov-a' AND bot_im_id='bot-a');
  ASSERT (SELECT payload->>'reason'='original' FROM public.ops_events WHERE corp_id='gov-a' AND idempotency_key='fact-1');
  ASSERT public.record_handoff(ticket||'{"corp_id":"gov-b","bot_im_id":"bot-b"}','agent_tool',NULL,NULL)='inserted';
  INSERT INTO public.user_hosting_status(user_id,is_paused,resumed_at) VALUES('shared',false,clock_timestamp());
  ASSERT public.resolve_hosting_handoffs('shared','resumed')=0;
  UPDATE public.user_hosting_status SET handoff_scope='{"chatId":"shared","corpId":"gov-a","botImId":"bot-a"}'::jsonb || jsonb_build_object('pausedAt',paused_at) WHERE user_id='shared';
  ASSERT public.resolve_hosting_handoffs('shared','resumed')=1;
  ASSERT (SELECT outcome IS NULL FROM public.handoff_events WHERE corp_id='gov-b' AND idempotency_key='fact-1');
  ASSERT public.resolve_hosting_handoffs('shared','resumed')=0;

  PERFORM public.transition_agent_action('prepare',p);
  PERFORM public.transition_agent_action('claim',own);
  -- Either form of historical key is reusable without rewriting the old evidence.
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
    VALUES('gov','act','dispatch','legacy-js-key',c);
  result := public.transition_agent_action('settle',own||jsonb_build_object('evidenceHash',md5(c::text),'completion',c));
  ASSERT result#>>'{record,status}'='succeeded' AND result#>>'{record,local_sync}'='pending';
  ASSERT (SELECT agent_action_records.result=c->'result' AND evidence=c->'evidence'
    FROM public.agent_action_records WHERE corp_id='gov' AND action_id='act');
  ASSERT (SELECT count(*)=1 FROM public.agent_action_evidence WHERE corp_id='gov' AND action_id='act');
  result := public.transition_agent_action('synced',own);
  ASSERT result#>'{record,result}'=c->'result' AND result#>'{record,evidence}'=c->'evidence';
  ASSERT (SELECT a.result=c->'result' FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
  PERFORM public.transition_agent_action('settle',own||jsonb_build_object('evidenceHash','other','completion',c||'{"result":{"workOrderId":13}}'));
  ASSERT public.action_terminal_evidence('gov','act','dispatch')='{"conflicting":true}';
  ASSERT (SELECT a.result=c->'result' FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
  ASSERT (SELECT a.result=c->'result' FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
END $$;
-- Recover either half of a historical handoff without emitting a second intervention.
DO $$
DECLARE ticket jsonb := jsonb_build_object('corp_id','gov-repair','bot_im_id','bot','chat_id','repair-chat',
  'reason_code','manual','reason','first','idempotency_key','missing-ticket','created_at',now()-interval '2 days');
  cutoff timestamptz := clock_timestamp();
BEGIN
  ASSERT public.record_handoff(ticket,'operator',NULL,NULL)='inserted';
  DELETE FROM public.handoff_events WHERE corp_id='gov-repair' AND idempotency_key='missing-ticket';
  ASSERT public.record_handoff(ticket||'{"reason":"retry","reason_code":"retry"}','other',NULL,NULL)='duplicate';
  ASSERT (SELECT reason='first' AND created_at=(ticket->>'created_at')::timestamptz FROM public.handoff_events
    WHERE corp_id='gov-repair' AND idempotency_key='missing-ticket');
  INSERT INTO public.handoff_events(chat_id,corp_id,bot_im_id,reason_code,reason,idempotency_key,created_at,sequence_no)
    VALUES('repair-chat','gov-repair','bot','original','ticket reason','missing-event',(ticket->>'created_at')::timestamptz,2);
  ASSERT public.record_handoff(ticket||'{"idempotency_key":"missing-event"}','operator',NULL,NULL)='duplicate';
  ASSERT (SELECT payload->>'reason'='ticket reason' AND occurred_at=(ticket->>'created_at')::timestamptz
    FROM public.ops_events WHERE corp_id='gov-repair' AND idempotency_key='missing-event');
  ASSERT (SELECT sum(handoff_count)=2 FROM public.daily_ops_report WHERE corp_id='gov-repair');

  BEGIN
    PERFORM public.record_handoff(ticket||'{"idempotency_key":"reject-ticket"}','operator',NULL,NULL);
    RAISE EXCEPTION 'missing simulated handoff failure';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'injected child failure' THEN RAISE; END IF; END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.ops_events WHERE corp_id='gov-repair' AND idempotency_key='reject-ticket');
  ASSERT (SELECT sum(handoff_count)=2 FROM public.daily_ops_report WHERE corp_id='gov-repair');

  ticket:=ticket||jsonb_build_object('idempotency_key','expired-ticket','created_at',now()-interval '91 days');
  ASSERT public.record_handoff(ticket,'operator',NULL,NULL)='inserted';
  DELETE FROM public.handoff_events WHERE corp_id='gov-repair' AND idempotency_key='expired-ticket';
  ASSERT public.record_handoff(ticket,'operator',NULL,NULL)='duplicate';
  ASSERT NOT EXISTS(SELECT 1 FROM public.handoff_events WHERE corp_id='gov-repair' AND idempotency_key='expired-ticket');

  INSERT INTO public.user_hosting_status(user_id,is_paused,paused_at,resumed_at,handoff_scope)
    VALUES('repair-chat',false,cutoff-interval '3 days',cutoff,
      jsonb_build_object('chatId','repair-chat','corpId','gov-repair','botImId','bot','pausedAt',cutoff-interval '3 days'));
  PERFORM public.resolve_hosting_handoffs('repair-chat','resumed');
  ASSERT (SELECT outcome IS NULL AND recorded_at>cutoff FROM public.handoff_events
    WHERE corp_id='gov-repair' AND idempotency_key='missing-ticket');
END $$;
-- Business statistics count the canonical tool list once.
DO $$
DECLARE started timestamptz:='2002-01-02T10:00:00Z'; calls jsonb:='[{"toolName":"gov_hourly_lookup","toolCallId":"1"}]';
BEGIN
  PERFORM public.save_processing_snapshot(jsonb_build_object('message_id','gov-report','chat_id','report','received_at',started,
    'status','success','tool_calls',calls,'agent_steps',jsonb_build_array(jsonb_build_object('toolCalls',calls))),NULL,'{}');
  ASSERT (SELECT tool_stats->>'gov_hourly_lookup'='1' AND message_count=1
    FROM public.aggregate_hourly_stats(started,started+interval '1 hour'));
END $$;
-- API acceptance and a delivery callback agree; a second channel message or definitive failure does not.
DO $$
DECLARE
  intent jsonb := jsonb_build_object('corpId','gov-receipt','accountId','bot','chatId','chat','logicalTurnId','turn',
    'kind','wecom.reply_segment','target','target','parameters','{"text":"fixture"}'::jsonb,'occurredAt',now());
  identity jsonb := '{"corpId":"gov-receipt","actionId":"one","requestId":"req","resourceHash":"target","payloadHash":"frozen","mode":"execute"}';
  own jsonb := '{"corpId":"gov-receipt","actionId":"one","owner":"dispatch","dispatchAttemptId":"dispatch","fence":1}';
  api_body jsonb := '{"status":"succeeded","result":{"stage":"accepted"},"evidence":{"kind":"accepted","requestTerminated":true}}';
  callback_input jsonb := '{"corpId":"gov-receipt","accountId":"bot","chatId":"chat","requestId":"req","messageId":"m1","messageType":"7","text":"fixture"}';
  contrary jsonb := '{"status":"failed","evidence":{"kind":"definitive_no_effect","requestTerminated":true}}';
  chosen jsonb; response jsonb;
BEGIN
  PERFORM public.transition_agent_action('prepare',identity||jsonb_build_object('intent',intent,'recoveryDeadline',now()+interval '1 day'));
  PERFORM public.transition_agent_action('claim',own);
  ASSERT public.append_agent_reply_callback(callback_input);
  response:=public.transition_agent_action('settle',own||jsonb_build_object('completion',api_body));
  ASSERT response#>>'{record,status}'='succeeded' AND (response#>>'{record,review_required}')::boolean=false;
  ASSERT response#>'{record,result}'=api_body->'result';
  ASSERT (SELECT count(*)=2 FROM public.agent_action_evidence WHERE corp_id='gov-receipt' AND action_id='one');
  chosen:=public.action_terminal_evidence('gov-receipt','one','dispatch');
  ASSERT chosen->'conflicting'='false' AND chosen#>>'{completion,result,channelMessageId}'='m1';
  ASSERT public.append_agent_reply_callback(callback_input);
  ASSERT public.action_terminal_evidence('gov-receipt','one','dispatch')=chosen;
  ASSERT public.append_agent_reply_callback(callback_input||'{"messageId":"m2"}');
  ASSERT public.action_terminal_evidence('gov-receipt','one','dispatch')='{"conflicting":true}';
  ASSERT public.action_terminal_evidence('gov-receipt','one','other')='{"conflicting":false}';

  own:=own||'{"actionId":"two"}'; identity:=identity||'{"actionId":"two","requestId":"req2","resourceHash":"target2"}';
  PERFORM public.transition_agent_action('prepare',identity||jsonb_build_object('intent',intent,'recoveryDeadline',now()+interval '1 day'));
  PERFORM public.transition_agent_action('claim',own);
  ASSERT public.append_agent_reply_callback(callback_input||'{"requestId":"req2"}');
  response:=public.transition_agent_action('settle',own||jsonb_build_object('completion',contrary));
  ASSERT response->>'conflict'='terminal_evidence_conflict' AND response#>>'{record,status}'='unknown';
  ASSERT public.action_terminal_evidence('gov-receipt','two','dispatch')='{"conflicting":true}';
END $$;
ROLLBACK;
