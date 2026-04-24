ALTER TABLE public.test_conversation_snapshots
  ADD COLUMN IF NOT EXISTS validation_title character varying(500);

COMMENT ON COLUMN public.test_conversation_snapshots.validation_title IS '验证集标题，用于回归验证列表展示';
