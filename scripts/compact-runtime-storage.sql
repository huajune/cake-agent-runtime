-- Explicitly apply one audit page. Only changed_keys go to restore-runtime-storage.sql.
-- psql -X -v keys='<eligible_keys JSON>' -f scripts/compact-runtime-storage.sql
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
CREATE OR REPLACE FUNCTION pg_temp.compact_runtime_keys(keys jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  entry jsonb;
  state text;
  before_body jsonb;
  chat public.chat_messages;
  action public.agent_action_records;
  changed jsonb := '[]';
  skipped jsonb := '{}';
BEGIN
  IF jsonb_typeof(keys) IS DISTINCT FROM 'array' OR jsonb_array_length(keys) > 100 THEN
    RAISE EXCEPTION 'Expected an array of at most 100 audited keys';
  END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(keys)
    ORDER BY value->>'type',value->>'corp',value->>'id' LOOP
    IF nullif(entry->>'id','') IS NULL THEN RAISE EXCEPTION 'Missing record id'; END IF;
    CASE entry->>'type'
    WHEN 'chat' THEN
      SELECT * INTO chat FROM public.chat_messages WHERE message_id=entry->>'id' FOR UPDATE;
      state := CASE WHEN FOUND THEN public.chat_body_storage_state(chat) ELSE 'missing_row' END;
      IF state = 'eligible' THEN
        IF NOT (public.runtime_storage_enabled('chat_text') AND public.runtime_storage_enabled('chat_mixed_text'))
          THEN RAISE EXCEPTION 'Enable chat compaction before applying audited keys'; END IF;
        before_body := public.chat_read_payload(chat);
        UPDATE public.chat_messages c SET payload=c.payload,payload_text_v1=-1
          WHERE c.message_id=chat.message_id RETURNING * INTO STRICT chat;
        IF chat.payload_text_v1 IS NULL OR public.chat_read_payload(chat) IS DISTINCT FROM before_body THEN
          RAISE EXCEPTION 'Chat payload failed round-trip verification';
        END IF;
      END IF;
    WHEN 'action' THEN
      IF nullif(entry->>'corp','') IS NULL THEN RAISE EXCEPTION 'Missing action corp'; END IF;
      SELECT * INTO action FROM public.agent_action_records
        WHERE corp_id=entry->>'corp' AND action_id=entry->>'id' FOR UPDATE;
      state := CASE WHEN FOUND THEN public.action_body_storage_state(action) ELSE 'missing_row' END;
      IF state = 'eligible' THEN
        IF NOT public.runtime_storage_enabled('action_body') OR
          (action.status='failed' AND NOT public.runtime_storage_enabled('action_failed_body'))
          THEN RAISE EXCEPTION 'Enable action compaction before applying audited keys'; END IF;
        before_body := public.action_record_json(action);
        UPDATE public.agent_action_records a SET result=a.result,evidence=a.evidence
          WHERE a.corp_id=action.corp_id AND a.action_id=action.action_id RETURNING * INTO STRICT action;
        IF action.body_ref_v1 IS NOT TRUE OR public.action_record_json(action) IS DISTINCT FROM before_body THEN
          RAISE EXCEPTION 'Accepted action receipt failed round-trip verification';
        END IF;
      END IF;
    ELSE RAISE EXCEPTION 'Expected a chat or action key'; END CASE;
    IF state IN ('broken_reference','missing_receipt') THEN RAISE EXCEPTION 'Existing reference is broken'; END IF;
    IF state = 'eligible' THEN changed := changed || jsonb_build_array(entry);
    ELSE skipped := jsonb_set(skipped,ARRAY[state],to_jsonb(coalesce((skipped->>state)::integer,0)+1)); END IF;
  END LOOP;
  RETURN jsonb_build_object('candidates',jsonb_array_length(keys),'changed',jsonb_array_length(changed),
    'changed_keys',changed,'skipped',skipped);
END $$;
SELECT pg_temp.compact_runtime_keys(:'keys'::jsonb) AS report \gset
COMMIT;
\echo :report
