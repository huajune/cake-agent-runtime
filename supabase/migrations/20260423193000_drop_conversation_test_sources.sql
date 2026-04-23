ALTER TABLE public.test_executions
  DROP CONSTRAINT IF EXISTS test_executions_conversation_source_id_fkey;

DROP TABLE IF EXISTS public.conversation_test_sources;

NOTIFY pgrst, 'reload schema';
