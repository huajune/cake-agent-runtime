-- psql -X -v ON_ERROR_STOP=1 -f scripts/backfill-runtime-bodies.sql
-- Run after the preparation migration, before the cutover, outside a transaction.
-- Each pass visits an increasing primary key and commits at most 250 rows.
\set ON_ERROR_STOP on
DO $$
BEGIN
  IF EXISTS (SELECT FROM public.system_config WHERE key='runtime_storage_writes' AND value<>'{}'::jsonb)
    THEN RAISE EXCEPTION 'Apply the preparation migration before restoring bodies'; END IF;
END $$;
SET lock_timeout='2s';
SET statement_timeout='15min';
CREATE PROCEDURE pg_temp.backfill_runtime_bodies() LANGUAGE plpgsql AS $$
DECLARE chat_key text; test_key uuid; corp_key text; action_key text; n integer;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.chat_messages'::regclass
    AND attname='payload_text_v1' AND NOT attisdropped) THEN RETURN; END IF;
  LOOP
    WITH page AS MATERIALIZED (
      SELECT message_id FROM public.chat_messages WHERE payload_text_v1 IS NOT NULL
        AND message_id>coalesce(chat_key,'') ORDER BY message_id LIMIT 250 FOR UPDATE
    ), changed AS (
      UPDATE public.chat_messages c SET payload=public.chat_read_payload(c),payload_text_v1=NULL
        FROM page WHERE c.message_id=page.message_id RETURNING c.message_id
    ) SELECT max(message_id),count(*) INTO chat_key,n FROM changed;
    COMMIT;
    EXIT WHEN n=0;
  END LOOP;
  LOOP
    WITH page AS MATERIALIZED (
      SELECT id FROM public.test_executions WHERE response_text_v1 IS NOT NULL
        AND (test_key IS NULL OR id>test_key) ORDER BY id LIMIT 250 FOR UPDATE
    ), changed AS (
      UPDATE public.test_executions t SET agent_response=public.test_read_response(t),response_text_v1=NULL
        FROM page WHERE t.id=page.id RETURNING t.id
    ) SELECT (array_agg(id ORDER BY id DESC))[1],count(*) INTO test_key,n FROM changed;
    COMMIT;
    EXIT WHEN n=0;
  END LOOP;
  LOOP
    FOR corp_key,action_key IN
      SELECT a.corp_id,a.action_id FROM public.agent_action_records a WHERE a.body_ref_v1 IS TRUE
        AND (corp_key IS NULL OR (a.corp_id,a.action_id)>(corp_key,action_key))
        ORDER BY a.corp_id,a.action_id LIMIT 250 FOR UPDATE
    LOOP
      UPDATE public.agent_action_records a SET result=e.completion->'result',evidence=e.completion->'evidence',body_ref_v1=NULL
        FROM public.agent_action_evidence e WHERE a.corp_id=corp_key AND a.action_id=action_key
        AND (a.corp_id,a.action_id,a.accepted_attempt_id,a.accepted_evidence_hash)=(e.corp_id,e.action_id,e.attempt_id,e.evidence_hash)
        AND a.accepted_attempt_id=a.dispatch_attempt_id AND e.completion->>'status'=a.status AND NOT a.retention_redacted;
      IF NOT FOUND THEN RAISE EXCEPTION 'Cannot resolve the accepted receipt for a referenced action'; END IF;
    END LOOP;
    EXIT WHEN NOT FOUND;
    COMMIT;
  END LOOP;
END $$;
CALL pg_temp.backfill_runtime_bodies();
DROP PROCEDURE pg_temp.backfill_runtime_bodies();
