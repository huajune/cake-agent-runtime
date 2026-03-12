-- ============================================================
-- Migration: Fix monitoring_error_logs.timestamp type
-- 2026-03-12
--
-- Problem: timestamp column is bigint (Unix ms), inconsistent
--          with all other timestamp columns which use timestamptz.
-- Solution: Convert to timestamptz in-place.
-- ============================================================

-- Step 1: Add new timestamptz column
ALTER TABLE monitoring_error_logs
  ADD COLUMN timestamp_new timestamptz;

-- Step 2: Convert existing Unix ms values to timestamptz
UPDATE monitoring_error_logs
  SET timestamp_new = to_timestamp("timestamp"::double precision / 1000.0)
  WHERE "timestamp" IS NOT NULL;

-- Step 3: Set NOT NULL (all rows should be populated)
ALTER TABLE monitoring_error_logs
  ALTER COLUMN timestamp_new SET NOT NULL;

-- Step 4: Drop old column and its index
DROP INDEX IF EXISTS idx_error_logs_timestamp;
ALTER TABLE monitoring_error_logs DROP COLUMN "timestamp";

-- Step 5: Rename new column to original name
ALTER TABLE monitoring_error_logs RENAME COLUMN timestamp_new TO "timestamp";

-- Step 6: Recreate index on new type
CREATE INDEX idx_error_logs_timestamp
  ON monitoring_error_logs("timestamp" DESC);

COMMENT ON COLUMN monitoring_error_logs."timestamp" IS
  '错误发生时间（timestamptz，由 bigint Unix ms 迁移而来）';
