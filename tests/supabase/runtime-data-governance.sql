-- Run after the complete migration chain in a disposable PostgreSQL database.
BEGIN;
SET LOCAL statement_timeout='5s';
SET LOCAL lock_timeout='1s';

CREATE FUNCTION pg_temp.reject_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'injected child failure'; END $$;
CREATE TRIGGER fail_one_snapshot BEFORE INSERT OR UPDATE ON public.message_processing_invocations
  FOR EACH ROW WHEN (NEW.message_id='gov-fail') EXECUTE FUNCTION pg_temp.reject_snapshot();

CREATE TRIGGER fail_one_handoff BEFORE INSERT ON public.handoff_events
  FOR EACH ROW WHEN (NEW.idempotency_key='reject-ticket') EXECUTE FUNCTION pg_temp.reject_snapshot();

SET LOCAL ROLE service_role;
INSERT INTO public.system_config(key,value) VALUES('runtime_storage_writes','{}')
  ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value;
DO $$
DECLARE
  r jsonb := '{"message_id":"gov-message","chat_id":"gov-chat","received_at":"2026-11-18T10:00:00Z","status":"success"}';
  calls jsonb := jsonb_build_array(jsonb_build_object('toolName','lookup','toolCallId','first','args',jsonb_build_object('id',repeat('A',80)),'result','ok','decisions',jsonb_build_array(jsonb_build_object('label','filter','detail','matched'))),
                                  jsonb_build_object('toolName','lookup','toolCallId','second','args',jsonb_build_object('id',repeat('A',80)),'error','retry'));
  steps jsonb; original jsonb; got jsonb; item jsonb; forbidden boolean:=false;
BEGIN
  steps := jsonb_build_array(jsonb_build_object('stepIndex',0,'attempt','original','toolCalls',jsonb_build_array(calls->0)),
    jsonb_build_object('stepIndex',0,'attempt','replan','toolCalls',jsonb_build_array(calls->1)));
  original := jsonb_build_object('request','frozen','response',jsonb_build_object('toolCalls',calls,'text','reply'));
  r := r||jsonb_build_object('tool_calls',calls,'agent_steps',steps);
  ASSERT public.save_processing_snapshot(r,original);
  ASSERT (SELECT agent_invocation=original AND response_tools_v1 IS NULL FROM public.message_processing_invocations WHERE message_id='gov-message');
  BEGIN PERFORM public.save_processing_snapshot(r||'{"message_id":"gov-fail"}',original);
    RAISE EXCEPTION 'missing injected failure';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'injected child failure' THEN RAISE; END IF; END;
  ASSERT NOT EXISTS(SELECT 1 FROM public.message_processing_records WHERE message_id='gov-fail');
  INSERT INTO public.system_config(key,value) VALUES('runtime_storage_writes',
    '{"steps":true,"response_tools":true,"chat_text":true,"test_text":true,"action_body":true}')
    ON CONFLICT(key) DO UPDATE SET value=excluded.value;
  ASSERT public.save_processing_snapshot(r,original);
  ASSERT (SELECT response_tools_v1 IS NOT NULL AND NOT ((agent_invocation->'response')?'toolCalls')
    AND public.processing_read_invocation(i)=original FROM public.message_processing_invocations i WHERE message_id='gov-message');
  ASSERT (SELECT step_tools_v1 IS NOT NULL AND public.processing_read_steps(m)=steps AND m.tool_calls=calls
    FROM public.message_processing_records m WHERE message_id='gov-message');
  PERFORM public.save_processing_snapshot(r,original);
  UPDATE public.message_processing_records SET tool_calls='[]' WHERE message_id='gov-message';
  ASSERT (SELECT superseded_invocation=original AND agent_invocation='null'::jsonb AND public.processing_read_invocation(i) IS NULL
    FROM public.message_processing_invocations i WHERE message_id='gov-message');
  ASSERT (SELECT public.processing_read_steps(m)=steps FROM public.message_processing_records m WHERE message_id='gov-message');
  FOR item IN SELECT value FROM jsonb_array_elements('[{},{"toolCalls":null},{"toolCalls":[]},{"toolCalls":[{"name":"different"}]}]') LOOP
    got := jsonb_build_object('response',item);
    PERFORM public.save_processing_snapshot(r,got);
    ASSERT (SELECT response_tools_v1 IS NULL AND public.processing_read_invocation(i)=got FROM public.message_processing_invocations i WHERE message_id='gov-message');
  END LOOP;
  PERFORM public.save_processing_snapshot(r||jsonb_build_object('agent_steps',jsonb_build_array(steps->1,steps->0)),original);
  ASSERT (SELECT step_tools_v1 IS NULL FROM public.message_processing_records WHERE message_id='gov-message');
  BEGIN
    UPDATE public.message_processing_invocations SET write_version=gen_random_uuid() WHERE message_id='gov-message';
    PERFORM public.processing_read_invocation(i) FROM public.message_processing_invocations i WHERE message_id='gov-message';
    RAISE EXCEPTION 'missing generation check';
  EXCEPTION WHEN raise_exception THEN IF SQLERRM<>'processing_invocation_reference_mismatch' THEN RAISE; END IF; END;
  FOREACH item IN ARRAY ARRAY['{"text":"hello"}','{"pureText":"hello"}','{"text":"hello","pureText":"hello"}',
      '{"text":null}','{}','{"text":"quoted","ref":"keep"}','{"text":"hello","externalId":"id"}']::jsonb[] LOOP
    INSERT INTO public.chat_messages(message_id,chat_id,content,role,timestamp,message_type,payload,payload_text_v1)
      VALUES('gov-chat-'||md5(item::text),'a','hello','user',now(),'TEXT',item,-1);
    ASSERT (SELECT public.chat_read_payload(c)=item FROM public.chat_messages c WHERE message_id='gov-chat-'||md5(item::text));
    IF item='{"text":"hello","pureText":"hello"}' THEN
      ASSERT (SELECT payload IS NULL AND payload_text_v1=3 FROM public.chat_messages WHERE message_id='gov-chat-'||md5(item::text));
      UPDATE public.chat_messages SET content='corrected' WHERE message_id='gov-chat-'||md5(item::text);
      ASSERT (SELECT public.chat_read_payload(c)=item FROM public.chat_messages c WHERE message_id='gov-chat-'||md5(item::text));
    END IF;
  END LOOP;
  INSERT INTO public.test_executions(id,test_input,actual_output,agent_response,response_text_v1,tool_calls)
    VALUES('00000000-0000-4000-a000-000000000001','{}','hello','{"text":"hello","tools":[1]}',-1,'[2]');
  ASSERT (SELECT response_text_v1=1 AND NOT (agent_response?'text') FROM public.test_executions WHERE id='00000000-0000-4000-a000-000000000001');
  ASSERT (SELECT agent_response='{"text":"hello","tools":[1]}' AND tool_calls='[2]' FROM public.test_execution_results WHERE id='00000000-0000-4000-a000-000000000001');
  UPDATE public.test_executions SET actual_output='different' WHERE id='00000000-0000-4000-a000-000000000001';
  ASSERT (SELECT actual_output='different' AND agent_response->>'text'='hello' FROM public.test_execution_results WHERE id='00000000-0000-4000-a000-000000000001');
  ASSERT has_table_privilege('service_role','agent_action_reviews','SELECT');
  ASSERT NOT has_table_privilege('service_role','agent_action_reviews','INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER');
  BEGIN DELETE FROM public.agent_action_reviews WHERE false;
  EXCEPTION WHEN insufficient_privilege THEN forbidden:=true; END;
  ASSERT forbidden;
  ASSERT NOT has_table_privilege('anon','test_execution_results','SELECT');
  ASSERT NOT has_function_privilege('authenticated','public.save_processing_snapshot(jsonb,jsonb)','EXECUTE');
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
  ASSERT (SELECT accepted_evidence_hash='legacy-js-key' AND accepted_attempt_id='dispatch' AND evidence IS NOT NULL
    FROM public.agent_action_records WHERE corp_id='gov' AND action_id='act');
  ASSERT (SELECT count(*)=1 FROM public.agent_action_evidence WHERE corp_id='gov' AND action_id='act');
  result := public.transition_agent_action('synced',own);
  ASSERT result#>'{record,result}'=c->'result' AND result#>'{record,evidence}'=c->'evidence';
  ASSERT (SELECT body_ref_v1 AND a.result IS NULL FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
  PERFORM public.transition_agent_action('settle',own||jsonb_build_object('evidenceHash','other','completion',c||'{"result":{"workOrderId":13}}'));
  ASSERT public.action_terminal_evidence('gov','act','dispatch')='{"conflicting":true}';
  ASSERT (SELECT public.action_record_json(a)->'result'=c->'result' FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
  UPDATE public.system_config SET value='{}' WHERE key='runtime_storage_writes';
  ASSERT (SELECT public.action_record_json(a)->'result'=c->'result' FROM public.agent_action_records a WHERE corp_id='gov' AND action_id='act');
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
-- The report reads the master's tool array and counts the same invocation exactly once in either format.
DO $$
DECLARE compact boolean; started timestamptz; item jsonb := '[{"toolName":"gov_hourly_lookup","toolCallId":"1"}]';
  rec jsonb; snap jsonb := jsonb_build_object('response',jsonb_build_object('toolCalls',item)); current_config jsonb;
BEGIN
  SELECT value INTO current_config FROM public.system_config WHERE key='runtime_storage_writes';
  FOREACH compact IN ARRAY ARRAY[false,true] LOOP
    started:=CASE WHEN compact THEN '2002-01-02T10:00:00Z'::timestamptz ELSE '2002-01-01T10:00:00Z'::timestamptz END;
    UPDATE public.system_config SET value=jsonb_build_object('response_tools',compact,'steps',compact) WHERE key='runtime_storage_writes';
    rec:=jsonb_build_object('message_id','gov-reports-'||compact,'chat_id','gov-reports','received_at',started,
      'status','success','tool_calls',item,'agent_steps',jsonb_build_array(jsonb_build_object('toolCalls',item)));
    ASSERT public.save_processing_snapshot(rec,snap);
    ASSERT (SELECT tool_stats->>'gov_hourly_lookup'='1' AND message_count=1
      FROM public.aggregate_hourly_stats(started,started+interval '1 hour'));
  END LOOP;
  UPDATE public.system_config SET value=current_config WHERE key='runtime_storage_writes';
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
