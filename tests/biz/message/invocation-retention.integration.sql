-- Run with psql against an empty disposable database.
\set ON_ERROR_STOP on
CREATE TABLE public.message_processing_records (
  id integer PRIMARY KEY,
  message_id text UNIQUE NOT NULL,
  received_at timestamptz NOT NULL
);
CREATE TABLE public.message_processing_invocations (
  message_id text PRIMARY KEY REFERENCES public.message_processing_records (message_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  agent_invocation jsonb NOT NULL
);

\ir ../../../supabase/migrations/20261124024050_align_invocation_retention_with_processing.sql
BEGIN;
INSERT INTO public.message_processing_records
  SELECT age, age::text, now() - make_interval(days => age)
  FROM unnest(ARRAY[6, 8, 89, 90, 91]) ages(age);
INSERT INTO public.message_processing_invocations
  SELECT message_id, received_at, '{}'::jsonb FROM public.message_processing_records;

DO $$
BEGIN
  IF public.delete_expired_agent_invocations() <> 1 THEN
    RAISE EXCEPTION 'Default retention must expire only the snapshot older than 90 days';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.message_processing_records p
    LEFT JOIN public.message_processing_invocations i USING (message_id)
    WHERE (i.message_id IS NOT NULL) <> (p.id <= 90)
  ) THEN
    RAISE EXCEPTION 'Unexpected snapshot at the 90-day retention boundary';
  END IF;
  IF public.delete_expired_agent_invocations(7, 1) <> 1 THEN
    RAISE EXCEPTION 'Explicit retention and batch limits must still be supported';
  END IF;
  IF (SELECT deleted_count FROM public.cleanup_message_processing_records()) <> 1
      OR (SELECT count(*) FROM public.message_processing_records WHERE id BETWEEN 61 AND 90) <> 2 THEN
    RAISE EXCEPTION 'Parent cleanup would cascade to retained snapshots before 90 days';
  END IF;
END;
$$;
ROLLBACK;
