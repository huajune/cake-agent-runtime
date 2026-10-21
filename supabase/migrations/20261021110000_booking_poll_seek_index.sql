-- Synthetic PostgreSQL 15 EXPLAIN: date-only index + OFFSET 8000 scans all 600k rows.
-- This partial index supports the two bounded (report_date,id) seek ranges.
-- Apply through the normal migration review; never run automatically against production.
CREATE INDEX IF NOT EXISTS idx_ops_events_booking_poll_seek
  ON public.ops_events (report_date, id)
  WHERE event_name = 'booking.succeeded';
