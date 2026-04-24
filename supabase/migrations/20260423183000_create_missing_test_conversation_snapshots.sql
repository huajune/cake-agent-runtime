CREATE TABLE IF NOT EXISTS public.test_conversation_snapshots (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  batch_id uuid NOT NULL,
  feishu_record_id character varying(100) NOT NULL,
  conversation_id character varying(100) NOT NULL,
  participant_name character varying(200),
  full_conversation jsonb NOT NULL,
  raw_text text,
  total_turns integer DEFAULT 0 NOT NULL,
  avg_similarity_score numeric,
  min_similarity_score numeric,
  status character varying(50) DEFAULT 'pending'::character varying,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  CONSTRAINT test_conversation_snapshots_pkey PRIMARY KEY (id)
);

CREATE INDEX IF NOT EXISTS idx_conversation_snapshots_batch_id
  ON public.test_conversation_snapshots USING btree (batch_id);
CREATE INDEX IF NOT EXISTS idx_conversation_snapshots_status
  ON public.test_conversation_snapshots USING btree (status);
CREATE INDEX IF NOT EXISTS idx_conversation_snapshots_batch_status
  ON public.test_conversation_snapshots USING btree (batch_id, status);

CREATE OR REPLACE FUNCTION public.update_conversation_snapshots_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgname = 'trigger_conversation_snapshots_updated_at'
  ) THEN
    CREATE TRIGGER trigger_conversation_snapshots_updated_at
      BEFORE UPDATE ON public.test_conversation_snapshots
      FOR EACH ROW
      EXECUTE FUNCTION public.update_conversation_snapshots_updated_at();
  END IF;
END;
$$;

ALTER TABLE public.test_conversation_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_conversation_snapshots'
      AND policyname = 'Allow public read'
  ) THEN
    CREATE POLICY "Allow public read"
      ON public.test_conversation_snapshots
      AS PERMISSIVE
      FOR SELECT
      TO public
      USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_conversation_snapshots'
      AND policyname = 'Service role insert'
  ) THEN
    CREATE POLICY "Service role insert"
      ON public.test_conversation_snapshots
      AS PERMISSIVE
      FOR INSERT
      TO public
      WITH CHECK (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_conversation_snapshots'
      AND policyname = 'Service role update'
  ) THEN
    CREATE POLICY "Service role update"
      ON public.test_conversation_snapshots
      AS PERMISSIVE
      FOR UPDATE
      TO public
      USING (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'test_conversation_snapshots'
      AND policyname = 'Service role delete'
  ) THEN
    CREATE POLICY "Service role delete"
      ON public.test_conversation_snapshots
      AS PERMISSIVE
      FOR DELETE
      TO public
      USING (((SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
