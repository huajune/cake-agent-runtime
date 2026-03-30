-- Add 'timeout' to message_processing_records status check constraint
-- 2026-03-30
--
-- Reason: data-cleanup.service marks stuck processing records as 'timeout',
-- but the existing CHECK constraint only allows ('processing', 'success', 'failure').

ALTER TABLE message_processing_records
  DROP CONSTRAINT chk_message_processing_status;

ALTER TABLE message_processing_records
  ADD CONSTRAINT chk_message_processing_status
  CHECK (status IN ('processing', 'success', 'failure', 'timeout'));
