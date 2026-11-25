-- Restore each body's original value once. Chat and test readers select their
-- native columns; action recovery reads the current decision from the action row.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '5min';
LOCK TABLE public.chat_messages, public.test_executions, public.agent_action_records,
  public.agent_action_evidence IN SHARE ROW EXCLUSIVE MODE;

DROP TRIGGER IF EXISTS a_chat_store_payload ON public.chat_messages;
DROP TRIGGER IF EXISTS z_chat_preserve_payload ON public.chat_messages;
DROP TRIGGER IF EXISTS a_test_store_response ON public.test_executions;
DROP TRIGGER IF EXISTS z_test_preserve_response ON public.test_executions;
DROP TRIGGER IF EXISTS action_pack_accepted_body ON public.agent_action_records;

DO $backfill$
DECLARE n integer;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.chat_messages'::regclass
      AND attname='payload_text_v1' AND NOT attisdropped) THEN RETURN; END IF;
  UPDATE public.chat_messages c SET payload=public.chat_read_payload(c) WHERE payload_text_v1 IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT; RAISE NOTICE 'Channel payloads restored: %',n;
  UPDATE public.test_executions t SET agent_response=public.test_read_response(t) WHERE response_text_v1 IS NOT NULL;
  GET DIAGNOSTICS n=ROW_COUNT; RAISE NOTICE 'Test responses restored: %',n;
  -- Fail closed on a missing or misattributed receipt: an unresolved external
  -- action must never turn into an empty result that a recovery worker might retry.
  IF EXISTS (SELECT FROM public.agent_action_records a LEFT JOIN public.agent_action_evidence e
      ON (a.corp_id,a.action_id,a.accepted_attempt_id,a.accepted_evidence_hash)=(e.corp_id,e.action_id,e.attempt_id,e.evidence_hash)
      WHERE a.body_ref_v1 IS TRUE AND (e.action_id IS NULL OR a.accepted_attempt_id IS DISTINCT FROM a.dispatch_attempt_id
        OR e.completion->>'status' IS DISTINCT FROM a.status OR a.retention_redacted)) THEN
    RAISE EXCEPTION 'Cannot resolve the accepted receipt for a referenced action';
  END IF;
  UPDATE public.agent_action_records a SET result=e.completion->'result',evidence=e.completion->'evidence'
    FROM public.agent_action_evidence e WHERE a.body_ref_v1 IS TRUE AND
    (a.corp_id,a.action_id,a.accepted_attempt_id,a.accepted_evidence_hash)=(e.corp_id,e.action_id,e.attempt_id,e.evidence_hash);
  GET DIAGNOSTICS n=ROW_COUNT; RAISE NOTICE 'Adopted action results restored: %',n;
END $backfill$;

-- Keep both variants' tenant filters, execution ownership, exact receipt writes,
-- grants and SECURITY DEFINER settings. Only retire the body-storage projection.
DO $routines$
DECLARE target regprocedure; definition text; old_predicate text; start_at integer; end_at integer;
BEGIN
  FOREACH target IN ARRAY ARRAY['public.transition_agent_action(text,jsonb)'::regprocedure,
                                'public.review_agent_action(jsonb)'::regprocedure] LOOP
    definition := pg_get_functiondef(target);
    IF strpos(definition,'accepted_evidence_hash')=0 THEN CONTINUE; END IF;
    definition := replace(definition,'accepted_attempt_id=r.dispatch_attempt_id,accepted_evidence_hash=v_accepted_hash,body_ref_v1=null,','');
    definition := replace(definition,'v_accepted_hash := public.store_action_completion','PERFORM public.store_action_completion');
    definition := replace(definition,'v_accepted_hash text;','');
    definition := replace(definition,'public.action_record_json(r)','to_jsonb(r)');
    IF definition ~ 'accepted_evidence_hash|body_ref_v1|v_accepted_hash|action_record_json' THEN
      RAISE EXCEPTION 'Unexpected action routine definition for %',target; END IF;
    EXECUTE definition;
  END LOOP;
  FOREACH target IN ARRAY ARRAY[
    'public.apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text)'::regprocedure,
    to_regprocedure('public.tenant_apply_active_booking_projection(text,text,text,text,bigint,timestamptz,bigint,text)')] LOOP
    CONTINUE WHEN target IS NULL;
    definition := pg_get_functiondef(target);
    IF strpos(definition,'body_ref_v1')=0 THEN CONTINUE; END IF;
    start_at := strpos(definition,'action_id IN (');
    end_at := strpos(definition,'AND a.body_ref_v1');
    IF start_at=0 OR end_at<=start_at THEN RAISE EXCEPTION 'Unexpected booking order predicate for %',target; END IF;
    old_predicate := substring(definition FROM start_at FOR end_at-start_at+length('AND a.body_ref_v1'));
    IF strpos(old_predicate,'raw.result->>''workOrderId''')=0 OR strpos(old_predicate,'UNION ALL')=0 THEN
      RAISE EXCEPTION 'Unknown accepted work order lookup for %',target; END IF;
    -- Include the closing parenthesis of the obsolete IN subquery.
    old_predicate := old_predicate || substring(substring(definition FROM end_at+length('AND a.body_ref_v1')) FROM '^\s*\)');
    IF old_predicate IS NULL THEN RAISE EXCEPTION 'Missing end of work order predicate'; END IF;
    EXECUTE replace(definition,old_predicate,'(result->>''workOrderId''=entry_id OR intent->''recovery''->>''workOrderId''=entry_id)');
  END LOOP;
END $routines$;

-- Receipts retain the original action-ledger primary key. Callers append an
-- observation and receive no storage key; adoption lives on the action itself.
DROP FUNCTION IF EXISTS public.store_action_completion(text,text,text,jsonb);
CREATE FUNCTION public.store_action_completion(p_corp text,p_id text,p_attempt text,p_body jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
BEGIN
  IF nullif(p_attempt,'') IS NULL OR jsonb_typeof(p_body) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'invalid action completion'; END IF;
  -- Transition, callback and review already hold the parent action's row lock.
  IF EXISTS (SELECT FROM public.agent_action_evidence WHERE corp_id=p_corp AND action_id=p_id
    AND attempt_id=p_attempt AND completion=p_body) THEN RETURN; END IF;
  INSERT INTO public.agent_action_evidence(corp_id,action_id,attempt_id,evidence_hash,completion)
    VALUES(p_corp,p_id,p_attempt,encode(sha256(convert_to(p_body::text,'UTF8')),'hex'),p_body);
END $$;
REVOKE ALL ON FUNCTION public.store_action_completion(text,text,text,jsonb) FROM PUBLIC,anon,authenticated,service_role;

DROP VIEW IF EXISTS public.test_execution_results RESTRICT;
DROP FUNCTION IF EXISTS public.action_pack_accepted_body(), public.action_body_storage_state(public.agent_action_records),
  public.action_record_json(public.agent_action_records), public.chat_body_storage_state(public.chat_messages),
  public.chat_store_payload(), public.chat_preserve_payload(), public.chat_read_payload(public.chat_messages),
  public.chat_payload_text_mask(text,jsonb), public.test_store_response(), public.test_preserve_response(),
  public.test_read_response(public.test_executions);
ALTER TABLE public.chat_messages DROP COLUMN IF EXISTS payload_text_v1;
ALTER TABLE public.test_executions DROP COLUMN IF EXISTS response_text_v1;
ALTER TABLE public.agent_action_records DROP COLUMN IF EXISTS body_ref_v1,
  DROP COLUMN IF EXISTS accepted_attempt_id, DROP COLUMN IF EXISTS accepted_evidence_hash;
DROP INDEX IF EXISTS public.idx_action_evidence_succeeded_work_order;
DROP FUNCTION IF EXISTS public.runtime_storage_enabled(text);
DELETE FROM public.system_config WHERE key='runtime_storage_writes';
NOTIFY pgrst,'reload schema';
COMMIT;
