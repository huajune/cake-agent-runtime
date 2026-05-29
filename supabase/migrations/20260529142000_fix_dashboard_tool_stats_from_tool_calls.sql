-- Ensure dashboard tool stats read the current observability column.
-- Some environments still have the pre-observability RPC that reads the legacy tools array,
-- which makes manual intervention stats show 0 even when tool_calls contains request_handoff.

CREATE OR REPLACE FUNCTION get_dashboard_tool_stats(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone
)
RETURNS TABLE(
  tool_name text,
  use_count bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    (call_entry->>'toolName')::text AS tool_name,
    COUNT(*)::bigint AS use_count
  FROM message_processing_records m,
       jsonb_array_elements(m.tool_calls) AS call_entry
  WHERE m.received_at >= p_start_date
    AND m.received_at < p_end_date
    AND m.tool_calls IS NOT NULL
    AND jsonb_typeof(m.tool_calls) = 'array'
    AND jsonb_array_length(m.tool_calls) > 0
    AND call_entry->>'toolName' IS NOT NULL
    AND call_entry->>'toolName' <> ''
  GROUP BY call_entry->>'toolName'
  ORDER BY use_count DESC;
END;
$$;

