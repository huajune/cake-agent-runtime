BEGIN;
SET LOCAL lock_timeout = '3s';
-- Disable future packing. Readers still see full bodies while the optional
-- bounded backfill runs before the coordinated application/schema cutover.
UPDATE public.system_config SET value='{}'::jsonb WHERE key='runtime_storage_writes';

COMMIT;
