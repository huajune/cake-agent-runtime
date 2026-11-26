\set ON_ERROR_STOP on
DO $$ BEGIN
  IF current_database() <> 'cake_projection_reply_load_1589' THEN RAISE EXCEPTION 'isolated load fixture required'; END IF;
END $$;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
INSERT INTO public.system_config(key,value) VALUES ('runtime_storage_writes','{"action_body":true,"action_failed_body":true}')
ON CONFLICT(key) DO UPDATE SET value=excluded.value;
INSERT INTO public.agent_action_records(corp_id,action_id,account_id,chat_id,logical_turn_id,kind,
  resource_hash,payload_hash,request_id,intent,input_occurred_at,mode,status,local_sync,
  recovery_deadline,dispatch_attempt_id,accepted_attempt_id,accepted_evidence_hash,created_at)
SELECT 'history',n::text,'bot','chat-'||(n%1000),'turn-'||n,'wecom.reply_segment',
  md5(n::text),md5(n::text),'r-'||n,jsonb_build_object('kind','wecom.reply_segment','parameters',
  jsonb_build_object('index',0,'text','历史合成回复')),now()-interval '1 day','execute','succeeded','complete',
  now(),'attempt','attempt','receipt',now()-interval '1 day' FROM generate_series(1,50000) n;
INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
SELECT 'history',n::text,'attempt','receipt','{"status":"succeeded","result":{"stage":"accepted"},"evidence":{"kind":"accepted","requestTerminated":true}}'
FROM generate_series(1,50000) n;
INSERT INTO public.agent_reply_turns(corp_id,logical_turn_id,account_id,chat_id,input_ids,input_occurred_at,mode,status)
SELECT 'history','turn-'||n,'bot','chat-'||(n%1000),ARRAY['in-'||n],now()-interval '1 day','execute','acked'
FROM generate_series(1,8000) n;
COMMIT;
ANALYZE public.agent_action_records;
ANALYZE public.agent_action_evidence;
ANALYZE public.agent_reply_turns;
