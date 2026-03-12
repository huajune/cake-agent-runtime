-- ============================================================
-- Migration: Add status CHECK constraint + fix booking NULL bypass
-- 2026-03-12
--
-- Changes:
-- 1. Add CHECK constraint on message_processing_records.status
--    to enforce allowed values (processing / success / failure)
-- 2. Fix increment_booking_count RPC: use COALESCE(brand_name, '')
--    and COALESCE(store_name, '') so NULL values don't bypass the
--    UNIQUE constraint (NULL != NULL in PG → ON CONFLICT never fired)
-- ============================================================

-- 1. Status CHECK constraint
ALTER TABLE message_processing_records
  ADD CONSTRAINT chk_message_processing_status
  CHECK (status IN ('processing', 'success', 'failure'));

-- 2. Fix booking NULL bypass
CREATE OR REPLACE FUNCTION increment_booking_count(
  p_date         date,
  p_brand_name   text,
  p_store_name   text,
  p_chat_id      text,
  p_user_id      text,
  p_user_name    text,
  p_manager_id   text,
  p_manager_name text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO interview_booking_records (
    date, brand_name, store_name, booking_count,
    chat_id, user_id, user_name, manager_id, manager_name
  ) VALUES (
    p_date,
    COALESCE(p_brand_name, ''),
    COALESCE(p_store_name, ''),
    1,
    p_chat_id, p_user_id, p_user_name, p_manager_id, p_manager_name
  )
  ON CONFLICT ON CONSTRAINT booking_stats_date_brand_name_store_name_key
  DO UPDATE SET
    booking_count = interview_booking_records.booking_count + 1,
    chat_id       = EXCLUDED.chat_id,
    user_id       = EXCLUDED.user_id,
    user_name     = EXCLUDED.user_name,
    manager_id    = EXCLUDED.manager_id,
    manager_name  = EXCLUDED.manager_name,
    updated_at    = now();
END;
$$;

COMMENT ON FUNCTION increment_booking_count IS
  '原子性地插入或递增预约计数。COALESCE(brand_name/store_name, '''') 确保 NULL 值不绕过唯一约束';
