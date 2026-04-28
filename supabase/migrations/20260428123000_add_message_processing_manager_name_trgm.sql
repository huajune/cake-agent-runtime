CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS idx_message_processing_records_manager_name_trgm
  ON public.message_processing_records
  USING gin (manager_name gin_trgm_ops)
  WHERE manager_name IS NOT NULL;
