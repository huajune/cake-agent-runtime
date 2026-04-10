-- Enable Realtime for message_processing_records table
-- This allows the frontend to subscribe to INSERT/UPDATE/DELETE events

ALTER PUBLICATION supabase_realtime ADD TABLE message_processing_records;
