-- New formats opt in independently via runtime_storage_writes. Old readers can
-- be rolled back after restoring the affected keys with restore-runtime-storage.sql.
BEGIN;
SET LOCAL lock_timeout = '2s';

CREATE OR REPLACE FUNCTION public.chat_payload_text_mask(content text, payload jsonb)
RETURNS smallint LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path = '' AS $$
  SELECT CASE WHEN content IS NOT NULL AND jsonb_typeof(payload) = 'object' THEN
    (CASE WHEN payload->'text' = to_jsonb(content) THEN 1 ELSE 0 END +
     CASE WHEN payload->'pureText' = to_jsonb(content) THEN 2 ELSE 0 END)::smallint
    ELSE 0::smallint END;
$$;

CREATE OR REPLACE FUNCTION public.chat_read_payload(m public.chat_messages)
RETURNS jsonb LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT CASE WHEN m.payload_text_v1 IS NULL THEN m.payload ELSE
    coalesce(m.payload, '{}'::jsonb) ||
    CASE WHEN (m.payload_text_v1 & 1) = 1 THEN jsonb_build_object('text', m.content) ELSE '{}' END ||
    CASE WHEN (m.payload_text_v1 & 2) = 2 THEN jsonb_build_object('pureText', m.content) ELSE '{}' END
  END;
$$;

CREATE OR REPLACE FUNCTION public.chat_store_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
  requested boolean := NEW.payload_text_v1 = -1;
  mask smallint;
  remaining jsonb;
BEGIN
  NEW.payload_text_v1 := NULL;
  IF requested IS NOT TRUE OR NEW.message_type IS DISTINCT FROM 'TEXT'
     OR (TG_OP = 'UPDATE' AND NEW.content IS DISTINCT FROM OLD.content)
     OR NOT public.runtime_storage_enabled('chat_text') THEN RETURN NEW; END IF;
  mask := public.chat_payload_text_mask(NEW.content, NEW.payload);
  IF mask = 0 THEN RETURN NEW; END IF;
  remaining := NEW.payload;
  IF (mask & 1) = 1 THEN remaining := remaining - 'text'; END IF;
  IF (mask & 2) = 2 THEN remaining := remaining - 'pureText'; END IF;
  IF remaining <> '{}'::jsonb AND NOT public.runtime_storage_enabled('chat_mixed_text') THEN
    RETURN NEW;
  END IF;
  NEW.payload_text_v1 := mask;
  NEW.payload := nullif(remaining, '{}'::jsonb);
  RETURN NEW;
END $$;

-- A media projection can read a physical payload after a type correction. A
-- combined replacement already cleared the marker in a_chat_store_payload.
CREATE OR REPLACE FUNCTION public.chat_preserve_payload() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.payload_text_v1 IS NOT NULL AND (NEW.content IS DISTINCT FROM OLD.content OR
    (NEW.message_type IS DISTINCT FROM OLD.message_type AND NEW.message_type IS DISTINCT FROM 'TEXT')) THEN
    NEW.payload := public.chat_read_payload(OLD);
    NEW.payload_text_v1 := NULL;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER z_chat_preserve_payload ON public.chat_messages;
CREATE TRIGGER z_chat_preserve_payload BEFORE UPDATE OF content,message_type ON public.chat_messages
  FOR EACH ROW EXECUTE FUNCTION public.chat_preserve_payload();

CREATE OR REPLACE FUNCTION public.chat_body_storage_state(m public.chat_messages)
RETURNS text LANGUAGE sql IMMUTABLE STRICT SET search_path = '' AS $$
  SELECT CASE
    WHEN m.payload_text_v1 IS NOT NULL THEN CASE
      WHEN m.payload_text_v1 NOT BETWEEN 1 AND 3 OR m.content IS NULL
        OR (m.payload IS NOT NULL AND jsonb_typeof(m.payload) <> 'object')
        OR ((m.payload_text_v1 & 1) = 1 AND m.payload ? 'text')
        OR ((m.payload_text_v1 & 2) = 2 AND m.payload ? 'pureText') THEN 'broken_reference'
      ELSE 'already_referenced' END
    WHEN m.message_type IS DISTINCT FROM 'TEXT' THEN 'keep_other_message_type'
    WHEN public.chat_payload_text_mask(m.content,m.payload) = 0 THEN 'keep_no_equal_text'
    ELSE 'eligible' END;
$$;

-- Classify one action against its accepted attempt and exact receipt. Reused by
-- the write trigger and the historical audit, including audit with writes off.
CREATE OR REPLACE FUNCTION public.action_body_storage_state(r public.agent_action_records)
RETURNS text LANGUAGE plpgsql STABLE STRICT SECURITY INVOKER SET search_path = '' AS $$
DECLARE body jsonb;
BEGIN
  IF r.retention_redacted AND r.body_ref_v1 IS NOT TRUE THEN RETURN 'redacted'; END IF;
  IF r.body_ref_v1 IS NOT TRUE THEN
    IF r.mode <> 'execute' THEN RETURN 'keep_observe_or_off'; END IF;
    IF r.review_required THEN
      IF r.dispatch_attempt_id IS NOT NULL AND
         public.action_terminal_evidence(r.corp_id,r.action_id,r.dispatch_attempt_id)->>'conflicting'='true'
        THEN RETURN 'keep_conflicting_receipts'; END IF;
      RETURN 'keep_review_required';
    END IF;
    IF r.retryable THEN RETURN 'keep_retryable'; END IF;
    IF r.status NOT IN ('succeeded','failed') THEN RETURN 'keep_' || r.status; END IF;
    IF r.local_sync <> 'complete' THEN RETURN 'keep_pending_sync'; END IF;
    IF r.accepted_attempt_id IS NULL OR r.accepted_attempt_id IS DISTINCT FROM r.dispatch_attempt_id
       OR r.accepted_evidence_hash IS NULL THEN RETURN 'unknown_accepted_identity'; END IF;
  END IF;
  SELECT e.completion INTO body FROM public.agent_action_evidence e
    WHERE (e.corp_id,e.action_id,e.attempt_id,e.evidence_hash) =
          (r.corp_id,r.action_id,r.accepted_attempt_id,r.accepted_evidence_hash);
  IF r.body_ref_v1 IS TRUE THEN
    IF NOT FOUND OR r.retention_redacted OR r.result IS NOT NULL OR r.evidence IS NOT NULL
       OR r.accepted_attempt_id IS DISTINCT FROM r.dispatch_attempt_id
       OR body->>'status' IS DISTINCT FROM r.status THEN RETURN 'broken_reference'; END IF;
    RETURN 'already_referenced';
  END IF;
  IF NOT FOUND THEN RETURN 'missing_receipt'; END IF;
  IF body->>'status' IS DISTINCT FROM r.status OR body->'result' IS DISTINCT FROM r.result
     OR body->'evidence' IS DISTINCT FROM r.evidence THEN RETURN 'keep_different_body'; END IF;
  IF r.status = 'failed' AND (body#>>'{evidence,kind}' IS DISTINCT FROM 'definitive_no_effect'
     OR body#>'{evidence,requestTerminated}' IS DISTINCT FROM 'true'::jsonb) THEN
    RETURN 'keep_unconfirmed_failure';
  END IF;
  IF public.action_terminal_evidence(r.corp_id,r.action_id,r.accepted_attempt_id)->>'conflicting' = 'true'
    THEN RETURN 'keep_conflicting_receipts'; END IF;
  RETURN 'eligible';
END $$;

CREATE OR REPLACE FUNCTION public.action_pack_accepted_body() RETURNS trigger
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE state text;
BEGIN
  IF NEW.retention_redacted THEN
    NEW.accepted_attempt_id := NULL;
    NEW.accepted_evidence_hash := NULL;
    NEW.body_ref_v1 := NULL;
  ELSIF NEW.body_ref_v1 IS NOT TRUE AND NEW.status IN ('succeeded','failed') AND NEW.local_sync = 'complete'
    AND public.runtime_storage_enabled('action_body')
    AND (NEW.status = 'succeeded' OR public.runtime_storage_enabled('action_failed_body')) THEN
    state := public.action_body_storage_state(NEW);
    IF state='missing_receipt' THEN RAISE EXCEPTION 'Accepted action receipt is missing'; END IF;
    IF state='eligible' THEN
      NEW.result := NULL;
      NEW.evidence := NULL;
      NEW.body_ref_v1 := true;
    END IF;
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.chat_payload_text_mask(text,jsonb),public.chat_body_storage_state(public.chat_messages),
  public.action_body_storage_state(public.agent_action_records) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.chat_payload_text_mask(text,jsonb),public.chat_body_storage_state(public.chat_messages),
  public.action_body_storage_state(public.agent_action_records) TO service_role;
COMMIT;
