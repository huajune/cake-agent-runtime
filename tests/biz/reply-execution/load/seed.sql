\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'cake_projection_reply_load_1589' THEN RAISE EXCEPTION 'isolated load fixture required'; END IF;
END $$;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
DO $$ BEGIN
  IF to_regclass('public.message_processing_turn_snapshots') IS NULL
    OR EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.agent_action_records'::regclass
      AND attname='accepted_evidence_hash' AND NOT attisdropped) THEN
    RAISE EXCEPTION 'Apply the combined message and reply migrations before running the load test';
  END IF;
END $$;
INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
  resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,local_sync,
  recovery_deadline,dispatch_attempt_id,result,evidence,created_at)
SELECT 'history',n::text,'bot','chat-'||(n%1000),'turn-'||n,'wecom.reply_segment',
  md5(n::text),md5(n::text),'r-'||n,jsonb_build_object('kind','wecom.reply_segment','parameters',
  jsonb_build_object('index',0,'text','历史合成回复')),now()-interval '1 day','execute','succeeded','complete',
  now(),'attempt','{"stage":"accepted"}','{"kind":"accepted","requestTerminated":true}',now()-interval '1 day'
FROM generate_series(1,50000) n;
INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
SELECT a.corp_id,a.action_id,a.dispatch_attempt_id,encode(sha256(convert_to(body::text,'UTF8')),'hex'),body
FROM public.agent_action_records a
CROSS JOIN LATERAL (SELECT jsonb_build_object('status',a.status,'result',a.result,'evidence',a.evidence) AS body) receipt
WHERE a.corp_id='history';
INSERT INTO public.agent_reply_turns(corp_id,logical_turn_id,account_id,chat_id,input_ids,input_occurred_at,mode,status)
SELECT 'history','turn-'||n,'bot','chat-'||(n%1000),ARRAY['in-'||n],now()-interval '1 day','execute','acked'
FROM generate_series(1,8000) n;
COMMIT;
ANALYZE public.agent_action_records;
ANALYZE public.agent_action_evidence;
ANALYZE public.agent_reply_turns;
