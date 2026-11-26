-- A successful order can exist only on the accepted receipt after compaction.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
CREATE INDEX IF NOT EXISTS idx_action_evidence_succeeded_work_order
  ON public.agent_action_evidence (corp_id,(completion#>>'{result,workOrderId}'))
  WHERE completion->>'status'='succeeded' AND completion#>>'{result,workOrderId}' IS NOT NULL;

-- Test and production can be at different stages of the tenant rollout. Change
-- only the order predicate in the implementation; keep the tenant filter, locking,
-- definer, grants and legacy forwarding wrapper installed in each database.
DO $migration$
DECLARE
  legacy regprocedure := 'public.apply_active_booking_projection(text,text,text,bigint,timestamptz,bigint,text)'::regprocedure;
  tenant regprocedure := to_regprocedure('public.tenant_apply_active_booking_projection(text,text,text,text,bigint,timestamptz,bigint,text)');
  target regprocedure;
  definition text;
  original text := $old$(result->>'workOrderId'=entry_id OR intent->'recovery'->>'workOrderId'=entry_id)$old$;
  replacement text := $new$action_id IN (
          SELECT raw.action_id FROM public.agent_action_records raw
          WHERE raw.corp_id=p_corp_id AND raw.mode='execute' AND raw.status='succeeded'
            AND raw.kind IN ('sponge.booking','sponge.cancel','sponge.modify')
            AND raw.input_occurred_at>p_occurred_at
            AND (raw.result->>'workOrderId'=entry_id OR raw.intent->'recovery'->>'workOrderId'=entry_id)
          UNION ALL
          SELECT a.action_id FROM public.agent_action_evidence e
          JOIN public.agent_action_records a ON (a.corp_id,a.action_id,a.accepted_attempt_id,a.accepted_evidence_hash)
            = (e.corp_id,e.action_id,e.attempt_id,e.evidence_hash)
          WHERE e.corp_id=p_corp_id AND e.completion->>'status'='succeeded'
            AND e.completion#>>'{result,workOrderId}'=entry_id AND a.body_ref_v1
        )$new$;
BEGIN
  FOREACH target IN ARRAY ARRAY[legacy,tenant] LOOP
    CONTINUE WHEN target IS NULL;
    definition := pg_get_functiondef(target);
    IF tenant IS NOT NULL AND target=legacy AND strpos(definition,'SELECT public.tenant_apply_active_booking_projection(NULL,')>0
       AND strpos(definition,original)=0 THEN CONTINUE; END IF;
    IF array_length(string_to_array(definition,original),1) <> 2 THEN
      RAISE EXCEPTION 'Unexpected booking projection definition for %',target;
    END IF;
    EXECUTE replace(definition,original,replacement);
  END LOOP;
END $migration$;
COMMIT;
