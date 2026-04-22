ALTER TABLE public.message_processing_records
ADD COLUMN IF NOT EXISTS post_processing_status jsonb;

COMMENT ON COLUMN public.message_processing_records.post_processing_status IS
  'Turn-end 后处理状态快照：running/completed/completed_with_errors，以及每个子步骤的 success/error/durationMs。';
