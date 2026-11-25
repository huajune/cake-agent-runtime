-- Disposable database after 20261124100200. Test with and without -v prebackfill=1.
\set ON_ERROR_STOP on
INSERT INTO public.system_config(key,value) VALUES('runtime_storage_writes',
  '{"steps":true,"response_tools":true,"chat_text":true,"chat_mixed_text":true,"test_text":true,"action_body":true}')
  ON CONFLICT(key) DO UPDATE SET value=excluded.value;
DO $seed$
DECLARE
  calls jsonb:=jsonb_build_array(jsonb_build_object('toolName','invite','args',repeat('a',140),'result',repeat('r',140)));
  steps jsonb:=jsonb_build_array(jsonb_build_object('stepIndex',0,'toolCalls',calls),
    jsonb_build_object('stepIndex',1,'toolCalls','[]'::jsonb));
  req jsonb:='{"agentRequest":{"instructions":"historical prompt","messages":[{"role":"user","content":"hello"}]}}';
  resp jsonb:=jsonb_build_object('toolCalls',calls,'reply','done','timings','{"durations":{"requestToFirstTextDeltaMs":174}}'::jsonb);
  record jsonb; name text;
BEGIN
  FOREACH name IN ARRAY ARRAY['both','step-only','response-only','direct','superseded','broken-step','stale-response'] LOOP
    UPDATE public.system_config SET value=value||jsonb_build_object('steps',name<>'response-only' AND name<>'direct',
      'response_tools', name<>'step-only' AND name<>'direct') WHERE key='runtime_storage_writes';
    record:=jsonb_build_object('message_id',name,'chat_id','chat','received_at',now(),'status','success','tool_calls',calls,'agent_steps',steps);
    PERFORM public.save_processing_snapshot(record,jsonb_build_object('request',req,'response',resp));
  END LOOP;
  ASSERT (SELECT step_tools_v1 IS NOT NULL FROM public.message_processing_records WHERE message_id='step-only');
  ASSERT (SELECT response_tools_v1 IS NULL FROM public.message_processing_invocations WHERE message_id='step-only');
  ASSERT (SELECT step_tools_v1 IS NULL FROM public.message_processing_records WHERE message_id='response-only');
  ASSERT (SELECT response_tools_v1 IS NOT NULL FROM public.message_processing_invocations WHERE message_id='response-only');
  UPDATE public.message_processing_records SET chat_id='corrected' WHERE message_id='superseded';
  UPDATE public.message_processing_records SET step_tools_v1='\x00' WHERE message_id='broken-step';
  UPDATE public.message_processing_invocations SET write_version=gen_random_uuid() WHERE message_id='stale-response';
  PERFORM public.save_processing_snapshot(jsonb_build_object('message_id','sdk-only','chat_id','chat','received_at',now(),'status','success'),
    '{"response":{"toolCalls":[{"toolCallId":"sdk-1","toolName":"search","input":{"q":"old"},"output":{"success":false},"state":"output-available"}]}}');
  INSERT INTO public.chat_messages(message_id,chat_id,role,content,timestamp,message_type,payload,payload_text_v1)
    SELECT 'old-chat-'||n,'chat','user','hello',now(),'TEXT','{"text":"hello","pureText":"hello","channelKey":3}',-1
    FROM generate_series(1,260) n;
  INSERT INTO public.test_executions(id,test_input,actual_output,agent_response,response_text_v1)
    VALUES('00000000-0000-4000-a000-000000000002','{}','hello','{"text":"hello","other":3}',-1);
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,
    request_id,intent,input_occurred_at,mode,recovery_deadline,status,local_sync,dispatch_attempt_id,accepted_attempt_id,accepted_evidence_hash,body_ref_v1)
    VALUES('cutover','action','bot','chat','turn','sponge.modify','resource','payload','request','{}',now(),'execute',now()+interval '1 day',
    'succeeded','complete','attempt','attempt','accepted',true);
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion) VALUES
    ('cutover','action','attempt','accepted','{"status":"succeeded","result":{"workOrderId":101},"evidence":{"requestTerminated":true}}'),
    ('cutover','action','attempt','late','{"status":"succeeded","result":{"workOrderId":102}}'),
    ('cutover','action','other','accepted','{"status":"succeeded","result":{"workOrderId":103}}');
END $seed$;
CREATE TEMP TABLE old_capture_times AS SELECT message_id,created_at FROM public.message_processing_invocations;
\ir ../../supabase/migrations/20261125075900_prepare_storage_cutover.sql
\if :{?prebackfill}
  \ir ../../scripts/backfill-runtime-bodies.sql
  \ir ../../scripts/backfill-runtime-bodies.sql
\endif
\ir ../../supabase/migrations/20261125080000_processing_snapshot_storage.sql
\ir ../../supabase/migrations/20261125081000_retire_body_storage_markers.sql
\ir ../../supabase/migrations/20261125080000_processing_snapshot_storage.sql
\ir ../../supabase/migrations/20261125081000_retire_body_storage_markers.sql
DO $verify$
BEGIN
  ASSERT NOT EXISTS (SELECT FROM information_schema.columns WHERE table_schema='public'
    AND column_name=ANY(ARRAY['step_tools_v1','invocation_version','write_version','response_tools_v1','superseded_invocation',
      'payload_text_v1','response_text_v1','body_ref_v1','accepted_attempt_id','accepted_evidence_hash','agent_invocation']));
  ASSERT (SELECT count(*)=4 AND bool_and(m.tool_calls#>'{0,stepPosition}'='0' AND m.agent_steps='[{"stepIndex":0},{"stepIndex":1}]'
    AND i.request#>>'{agentRequest,instructions}'='historical prompt' AND i.response->>'reply'='done'
    AND NOT i.response?'toolCalls' AND i.created_at=t.created_at AND m.ttft_ms=174)
    FROM message_processing_records m JOIN message_processing_invocations i USING(message_id)
    JOIN old_capture_times t USING(message_id) WHERE m.message_id IN ('both','step-only','response-only','direct'));
  ASSERT NOT EXISTS (SELECT FROM message_processing_invocations WHERE message_id IN ('superseded','stale-response'));
  ASSERT (SELECT tool_calls='[{"toolCallId":"sdk-1","toolName":"search","args":{"q":"old"},"result":{"success":false},"status":"error"}]'
    FROM message_processing_records WHERE message_id='sdk-only');
  ASSERT EXISTS (SELECT FROM message_processing_records WHERE message_id='broken-step' AND tool_calls#>>'{0,toolName}'='invite'
    AND NOT (tool_calls->0)?'stepPosition');
  ASSERT (SELECT count(*)=260 AND bool_and(payload='{"text":"hello","pureText":"hello","channelKey":3}')
    FROM chat_messages WHERE message_id LIKE 'old-chat-%');
  ASSERT (SELECT agent_response='{"text":"hello","other":3}' FROM test_executions WHERE id='00000000-0000-4000-a000-000000000002');
  ASSERT (SELECT result='{"workOrderId":101}' AND evidence='{"requestTerminated":true}' AND request_id='request'
    FROM agent_action_records WHERE corp_id='cutover' AND action_id='action');
  ASSERT (SELECT count(*)=3 FROM agent_action_evidence WHERE corp_id='cutover' AND action_id='action');
  ASSERT NOT EXISTS(SELECT FROM system_config WHERE key='runtime_storage_writes');
  ASSERT NOT has_function_privilege('anon','public.processing_request_context(public.message_processing_invocations)','EXECUTE');
END $verify$;
