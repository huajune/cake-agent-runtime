CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_message_processing_records_user_name_trgm
  ON public.message_processing_records
  USING gin (user_name gin_trgm_ops)
  WHERE user_name IS NOT NULL;
