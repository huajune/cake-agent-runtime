ALTER TABLE public.test_executions
  ADD COLUMN IF NOT EXISTS conversation_snapshot_id uuid;

UPDATE public.test_executions
SET conversation_snapshot_id = conversation_source_id
WHERE conversation_snapshot_id IS NULL
  AND conversation_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_test_executions_conversation_snapshot
  ON public.test_executions USING btree (conversation_snapshot_id);

CREATE INDEX IF NOT EXISTS idx_test_executions_conv_turn
  ON public.test_executions USING btree (conversation_snapshot_id, turn_number)
  WHERE (conversation_snapshot_id IS NOT NULL);

NOTIFY pgrst, 'reload schema';
