-- Run this backfill with psql before switching to child-only readers in each environment.
-- The old application already reads the child. Replaying the file during db push is safe.
BEGIN;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

DO $$
DECLARE
  legacy record;
  child public.message_processing_invocations%ROWTYPE;
  preserved jsonb;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_attribute WHERE attrelid='public.message_processing_records'::regclass
                 AND attname='agent_invocation' AND NOT attisdropped) THEN RETURN; END IF;
  -- Lock only parents carrying legacy data. A JSON null is an actual stored value.
  FOR legacy IN
    SELECT message_id, received_at, invocation_version, agent_invocation
    FROM public.message_processing_records WHERE agent_invocation IS NOT NULL
    ORDER BY id FOR UPDATE
  LOOP
    IF legacy.invocation_version IS NULL THEN
      INSERT INTO public.message_processing_invocations (message_id, agent_invocation, created_at)
      VALUES (legacy.message_id, legacy.agent_invocation, legacy.received_at)
      ON CONFLICT (message_id) DO NOTHING;
    END IF;
    SELECT * INTO child FROM public.message_processing_invocations
    WHERE message_id = legacy.message_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Versioned parent % has a legacy snapshot without a child', legacy.message_id;
    END IF;
    IF child.superseded_invocation IS NOT NULL THEN
      IF legacy.invocation_version IS NULL THEN
        RAISE EXCEPTION 'Unversioned parent % has a superseded child', legacy.message_id;
      END IF;
      preserved := child.superseded_invocation;
    ELSE
      preserved := public.processing_read_invocation(child);
    END IF;
    IF preserved IS DISTINCT FROM legacy.agent_invocation THEN
      RAISE EXCEPTION 'Legacy and child snapshots differ for %', legacy.message_id;
    END IF;
    UPDATE public.message_processing_records SET agent_invocation = NULL
    WHERE message_id = legacy.message_id;
  END LOOP;
END $$;
COMMIT;
