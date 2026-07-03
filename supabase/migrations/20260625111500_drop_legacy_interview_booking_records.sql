-- Drop legacy interview booking aggregate table.
--
-- Booking success is now written through ops_events('booking.succeeded') and
-- projected into daily_ops_report.booking_success_count. Dashboard and reports
-- read that projection directly, so the old aggregate table/RPC must not keep
-- receiving duplicate writes.

DROP FUNCTION IF EXISTS increment_booking_count(
  date,
  text,
  text,
  text,
  text,
  text,
  text,
  text
);

DROP TABLE IF EXISTS interview_booking_records;
