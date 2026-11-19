-- psql -X -v ON_ERROR_STOP=1 -v keys='[{"type":"processing","id":"..."}]' -f scripts/restore-runtime-storage.sql
-- Types: processing, chat, test, action (also requires "corp"). Supply indexed keys from the release audit.
BEGIN;
SET LOCAL lock_timeout='1s';
SET LOCAL statement_timeout='5s';
CREATE OR REPLACE FUNCTION pg_temp.restore_runtime_keys(keys jsonb) RETURNS integer
LANGUAGE plpgsql SET search_path='' AS $$
DECLARE entry jsonb; n int:=0; changed int; key_id text; body jsonb; m public.message_processing_records;
BEGIN
  IF jsonb_typeof(keys) IS DISTINCT FROM 'array' OR jsonb_array_length(keys)>100 THEN
    RAISE EXCEPTION 'provide up to 100 explicit keys'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(keys) ORDER BY value->>'type',value->>'corp',value->>'id' LOOP
    key_id:=entry->>'id'; IF nullif(key_id,'') IS NULL THEN RAISE EXCEPTION 'missing id'; END IF;
    CASE entry->>'type'
    WHEN 'processing' THEN
      IF public.runtime_storage_enabled('steps') OR public.runtime_storage_enabled('response_tools') THEN RAISE EXCEPTION 'disable processing compaction first'; END IF;
      SELECT * INTO m FROM public.message_processing_records WHERE message_id=key_id FOR UPDATE;
      IF NOT FOUND THEN CONTINUE; END IF;
      UPDATE public.message_processing_invocations i SET agent_invocation=public.processing_read_invocation(i),response_tools_v1=NULL
        WHERE i.message_id=m.message_id AND response_tools_v1 IS NOT NULL;
      GET DIAGNOSTICS changed=ROW_COUNT; n:=n+changed;
      UPDATE public.message_processing_records SET agent_steps=public.processing_read_steps(m),step_tools_v1=NULL
        WHERE message_id=m.message_id AND step_tools_v1 IS NOT NULL;
    WHEN 'chat' THEN
      IF public.runtime_storage_enabled('chat_text') THEN RAISE EXCEPTION 'disable chat compaction first'; END IF;
      UPDATE public.chat_messages c SET payload=public.chat_read_payload(c),payload_text_v1=NULL
        WHERE c.message_id=key_id AND c.payload_text_v1 IS NOT NULL;
    WHEN 'test' THEN
      IF public.runtime_storage_enabled('test_text') THEN RAISE EXCEPTION 'disable test compaction first'; END IF;
      UPDATE public.test_executions t SET agent_response=public.test_read_response(t),response_text_v1=NULL
        WHERE t.id=(entry->>'id')::uuid AND t.response_text_v1=1;
    WHEN 'action' THEN
      IF public.runtime_storage_enabled('action_body') THEN RAISE EXCEPTION 'disable action compaction first'; END IF;
      IF nullif(entry->>'corp','') IS NULL THEN RAISE EXCEPTION 'action requires corp'; END IF;
      SELECT e.completion INTO body FROM public.agent_action_records a
        LEFT JOIN public.agent_action_evidence e ON e.corp_id=a.corp_id AND e.action_id=a.action_id
          AND e.attempt_id=a.accepted_attempt_id AND e.evidence_hash=a.accepted_evidence_hash
        WHERE a.corp_id=entry->>'corp' AND a.action_id=key_id AND a.body_ref_v1 FOR UPDATE OF a;
      IF NOT FOUND THEN CONTINUE; END IF;
      IF body IS NULL THEN RAISE EXCEPTION 'accepted completion missing'; END IF;
      UPDATE public.agent_action_records a SET result=body->'result',evidence=body->'evidence',body_ref_v1=NULL
        WHERE a.corp_id=entry->>'corp' AND a.action_id=key_id AND a.body_ref_v1;
    ELSE RAISE EXCEPTION 'unsupported key type'; END CASE;
    GET DIAGNOSTICS changed=ROW_COUNT; n:=n+changed;
  END LOOP;
  RETURN n;
END $$;
SELECT pg_temp.restore_runtime_keys(:'keys'::jsonb) AS restored_rows;
COMMIT;
