-- Transaction-scoped synthetic rows only; safe to run against the migrated test DB.
BEGIN;
SET LOCAL statement_timeout='10s';
SET LOCAL lock_timeout='1s';
DO $$
DECLARE n integer; total integer:=0; loops integer:=0;
BEGIN
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,local_sync,updated_at,recovery_deadline)
  SELECT 'retention-test-20261023', 'observe-'||i, 'bot', 'chat', 'turn-'||i, 'wecom.reply_segment', 'res-'||i, 'hash', 'request-'||i,
    '{"parameters":{"text":"synthetic private text"},"recovery":{"name":"synthetic"},"target":"chat","kind":"wecom.reply_segment"}'::jsonb,
    now()-interval '92 days', CASE WHEN i%2=0 THEN 'observe' ELSE 'off' END, 'executing','complete',now()-interval '91 days',now()-interval '91 days'
  FROM generate_series(1,205) i;
  -- Zero and multiple evidence rows must not change the processed-action count.
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
    VALUES ('retention-test-20261023','observe-1','attempt','one','{"private":"evidence"}'),
           ('retention-test-20261023','observe-1','attempt','two','{"private":"evidence"}');
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,local_sync,updated_at,recovery_deadline)
  SELECT 'retention-test-20261023', 'protected-'||i, 'bot', 'chat', 't-'||i, 'sponge.booking','protected-'||i,'hash','protected-'||i,
    '{"parameters":{"phone":"synthetic"}}',now()-interval '92 days', 'execute',
    CASE WHEN i=1 THEN 'unknown' WHEN i=2 THEN 'executing' ELSE 'succeeded' END,
    CASE WHEN i=3 THEN 'pending' ELSE 'complete' END,now()-interval '91 days',now()-interval '91 days'
  FROM generate_series(1,3) i;
  -- Recent observations must remain intact.
  INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,local_sync,updated_at,recovery_deadline)
    VALUES ('retention-test-20261023','recent','bot','chat','recent','wecom.reply_segment','recent','hash','recent',
      '{"parameters":{"text":"recent"}}',now(),'observe','executing','complete',now(),now()+interval '1 day');
  LOOP
    n:=public.redact_completed_agent_actions(100);
    ASSERT n BETWEEN 0 AND 100;
    total:=total+n; loops:=loops+1;
    EXIT WHEN n<100;
    ASSERT loops<100, 'retention did not converge';
  END LOOP;
  ASSERT total>=205, 'zero-evidence actions were omitted from count';
  ASSERT (SELECT count(*)=205 FROM public.agent_action_records WHERE corp_id='retention-test-20261023' AND retention_redacted);
  ASSERT NOT EXISTS(SELECT 1 FROM public.agent_action_records WHERE corp_id='retention-test-20261023' AND action_id LIKE 'observe-%' AND
    (intent ? 'parameters' OR intent ? 'recovery' OR intent ? 'target' OR status<>'executing'));
  ASSERT NOT EXISTS(SELECT 1 FROM public.agent_action_evidence WHERE corp_id='retention-test-20261023');
  ASSERT (SELECT count(*)=4 FROM public.agent_action_records WHERE corp_id='retention-test-20261023' AND NOT retention_redacted AND intent ? 'parameters');
  ASSERT public.redact_completed_agent_actions(100)=0, 'repeated cleanup is not idempotent';
  ASSERT NOT has_function_privilege('authenticated','public.redact_completed_agent_actions(integer)','execute');
  INSERT INTO public.agent_reply_turns(corp_id,account_id,chat_id,logical_turn_id,input_ids,input_occurred_at,mode,status,plan,recovery,updated_at)
    SELECT 'retention-test-20261023','bot','chat','reply-'||i,ARRAY['input-'||i],now()-interval '92 days','execute','acked',
      '{"text":"synthetic reply"}'::jsonb,'{"private":"synthetic recovery"}'::jsonb,now()-interval '91 days'
    FROM generate_series(1,205) i;
  total:=0; loops:=0;
  LOOP
    n:=public.redact_completed_agent_reply_turns(100);
    ASSERT n BETWEEN 0 AND 100;
    total:=total+n; loops:=loops+1;
    EXIT WHEN n<100;
    ASSERT loops<100, 'reply retention did not converge';
  END LOOP;
  ASSERT total>=205;
  ASSERT (SELECT count(*)=205 FROM public.agent_reply_turns WHERE corp_id='retention-test-20261023' AND plan IS NULL AND recovery='{}'::jsonb AND status='acked');
  ASSERT public.redact_completed_agent_reply_turns(100)=0;
END $$;
ROLLBACK;
