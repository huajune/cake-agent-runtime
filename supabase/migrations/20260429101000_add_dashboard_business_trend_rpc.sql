-- Dashboard 业务趋势聚合。
--
-- 之前接口会把当前时间段的原始 message_processing_records 拉回 Node 再聚合，
-- 周/月范围下容易放大网络传输和 JSON 反序列化成本。这里改为数据库侧按
-- Asia/Shanghai 口径聚合，只返回图表点。

CREATE OR REPLACE FUNCTION get_dashboard_business_trend(
  p_start_date timestamp with time zone,
  p_end_date timestamp with time zone,
  p_interval_minutes integer DEFAULT 5,
  p_granularity text DEFAULT 'minute'
)
RETURNS TABLE(
  minute text,
  consultations bigint,
  booking_attempts bigint,
  successful_bookings bigint,
  conversion_rate numeric,
  booking_success_rate numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH base AS (
    SELECT
      CASE
        WHEN p_granularity = 'day' THEN
          to_char(m.received_at AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM-DD')
        ELSE
          to_char(
            date_trunc('minute', m.received_at AT TIME ZONE 'Asia/Shanghai')
              - (
                EXTRACT(minute FROM m.received_at AT TIME ZONE 'Asia/Shanghai')::int
                % GREATEST(p_interval_minutes, 1)
              ) * interval '1 minute',
            'YYYY-MM-DD HH24:MI'
          )
      END AS bucket,
      m.user_id,
      tool_call.value AS tool_call
    FROM message_processing_records m
    LEFT JOIN LATERAL jsonb_array_elements(
      CASE
        WHEN jsonb_typeof(m.tool_calls) = 'array' THEN m.tool_calls
        ELSE '[]'::jsonb
      END
    ) AS tool_call(value)
      ON COALESCE(tool_call.value->>'toolName', tool_call.value->>'name') = 'duliday_interview_booking'
    WHERE m.received_at >= p_start_date
      AND m.received_at < p_end_date
  ),
  grouped AS (
    SELECT
      base.bucket,
      COUNT(DISTINCT base.user_id)::bigint AS consultations,
      COUNT(base.tool_call)::bigint AS booking_attempts,
      COUNT(base.tool_call) FILTER (
        WHERE base.tool_call->'result'->>'success' = 'true'
          OR base.tool_call->'result'->'object'->>'success' = 'true'
      )::bigint AS successful_bookings
    FROM base
    GROUP BY base.bucket
  )
  SELECT
    grouped.bucket AS minute,
    grouped.consultations,
    grouped.booking_attempts,
    grouped.successful_bookings,
    ROUND(
      CASE
        WHEN grouped.consultations > 0
        THEN (grouped.booking_attempts::numeric / grouped.consultations::numeric) * 100
        ELSE 0
      END,
      2
    ) AS conversion_rate,
    ROUND(
      CASE
        WHEN grouped.booking_attempts > 0
        THEN (grouped.successful_bookings::numeric / grouped.booking_attempts::numeric) * 100
        ELSE 0
      END,
      2
    ) AS booking_success_rate
  FROM grouped
  ORDER BY grouped.bucket ASC;
END;
$$;
