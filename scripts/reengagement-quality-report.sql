-- Reengagement quality report
-- Usage:
--   1. Set the window in the params CTE.
--   2. Run against production/staging Supabase SQL editor or psql.
--   3. The report keeps row-level visibility available through the final detail query.

-- ====================
-- 1) Overall metrics
-- ====================
WITH params AS (
  SELECT
    now() - interval '3 days' AS start_at,
    now() AS end_at
),
base AS (
  SELECT
    r.*,
    coalesce(r.generated_text, '') AS text
  FROM reengagement_touch_records r
  CROSS JOIN params p
  WHERE r.created_at >= p.start_at
    AND r.created_at < p.end_at
    AND r.status IN ('shadow', 'sent', 'failed', 'stopped', 'frequency_blocked', 'duplicate')
),
classified AS (
  SELECT
    *,
    status IN ('shadow', 'sent') AND outcome_kind = 'reply' AND length(trim(text)) > 0 AS generated_reply,
    decision_reason = 'session_touch_cooldown' AS session_touch_cooldown,
    decision_reason LIKE 'composer_%' AS composer_blocked,
    text ~ '(\[|【)消息发送时间' AS timestamp_leak,
    text ~ '(✅|<system>|</system>|工具调用结果|对话已完成|符合.{0,8}阶段要求)' AS internal_leak,
    text ~ '([0-9]+(\.[0-9]+)?[[:space:]]*(元|块)|薪资|工资|时薪|日薪|月薪|早班|晚班|中班|夜班|班次|小时工|日结|周结|月结)' AS job_dump,
    char_length(text) > CASE
      WHEN scenario_code = 'interview_reminder' THEN 120
      WHEN scenario_code = 'booking_incomplete' THEN 100
      ELSE 80
    END AS too_long,
    scenario_code = 'address_missing'
      AND status IN ('shadow', 'sent')
      AND outcome_kind = 'reply'
      AND text !~ '(位置|地址|定位|附近|就近|地铁|商圈)' AS missing_expected_ask
  FROM base
)
SELECT
  count(*) AS total_touches,
  count(*) FILTER (WHERE generated_reply) AS generated_replies,
  count(*) FILTER (WHERE status = 'sent') AS sent,
  count(*) FILTER (WHERE status = 'shadow') AS shadow,
  count(*) FILTER (WHERE session_touch_cooldown) AS session_touch_cooldown,
  count(*) FILTER (WHERE composer_blocked) AS composer_blocked,
  count(*) FILTER (WHERE timestamp_leak) AS timestamp_leak,
  count(*) FILTER (WHERE internal_leak) AS internal_leak,
  count(*) FILTER (WHERE job_dump) AS job_dump,
  count(*) FILTER (WHERE too_long) AS too_long,
  count(*) FILTER (WHERE missing_expected_ask) AS missing_expected_ask,
  count(*) FILTER (
    WHERE generated_reply
      AND NOT timestamp_leak
      AND NOT internal_leak
      AND NOT job_dump
      AND NOT too_long
      AND NOT missing_expected_ask
  ) AS clean_generated_replies,
  round(
    100.0 * count(*) FILTER (
      WHERE generated_reply
        AND NOT timestamp_leak
        AND NOT internal_leak
        AND NOT job_dump
        AND NOT too_long
        AND NOT missing_expected_ask
    ) / nullif(count(*), 0),
    2
  ) AS strict_clean_rate_pct
FROM classified;

-- ====================
-- 2) Metrics by scenario
-- ====================
WITH params AS (
  SELECT now() - interval '3 days' AS start_at, now() AS end_at
),
base AS (
  SELECT r.*, coalesce(r.generated_text, '') AS text
  FROM reengagement_touch_records r
  CROSS JOIN params p
  WHERE r.created_at >= p.start_at
    AND r.created_at < p.end_at
),
classified AS (
  SELECT
    *,
    status IN ('shadow', 'sent') AND outcome_kind = 'reply' AND length(trim(text)) > 0 AS generated_reply,
    decision_reason LIKE 'composer_%' AS composer_blocked,
    text ~ '(\[|【)消息发送时间' AS timestamp_leak,
    text ~ '(✅|<system>|</system>|工具调用结果|对话已完成|符合.{0,8}阶段要求)' AS internal_leak,
    text ~ '([0-9]+(\.[0-9]+)?[[:space:]]*(元|块)|薪资|工资|时薪|日薪|月薪|早班|晚班|中班|夜班|班次|小时工|日结|周结|月结)' AS job_dump,
    char_length(text) > CASE
      WHEN scenario_code = 'interview_reminder' THEN 120
      WHEN scenario_code = 'booking_incomplete' THEN 100
      ELSE 80
    END AS too_long
  FROM base
)
SELECT
  scenario_code,
  count(*) AS total,
  count(*) FILTER (WHERE generated_reply) AS generated_replies,
  count(*) FILTER (WHERE status = 'sent') AS sent,
  count(*) FILTER (WHERE status = 'shadow') AS shadow,
  count(*) FILTER (WHERE decision_reason = 'session_touch_cooldown') AS cooldown_skips,
  count(*) FILTER (WHERE composer_blocked) AS composer_blocks,
  count(*) FILTER (WHERE timestamp_leak OR internal_leak OR job_dump OR too_long) AS hard_content_errors
FROM classified
GROUP BY scenario_code
ORDER BY total DESC, scenario_code;

-- ====================
-- 3) Suspected duplicate pairs within a session
-- ====================
WITH params AS (
  SELECT now() - interval '3 days' AS start_at, now() AS end_at
),
touches AS (
  SELECT
    session_id,
    scenario_code,
    touch_key,
    created_at,
    generated_text,
    lag(scenario_code) OVER (PARTITION BY session_id ORDER BY created_at) AS prev_scenario,
    lag(touch_key) OVER (PARTITION BY session_id ORDER BY created_at) AS prev_touch_key,
    lag(created_at) OVER (PARTITION BY session_id ORDER BY created_at) AS prev_created_at
  FROM reengagement_touch_records r
  CROSS JOIN params p
  WHERE r.created_at >= p.start_at
    AND r.created_at < p.end_at
    AND r.status IN ('shadow', 'sent')
)
SELECT
  session_id,
  prev_scenario,
  scenario_code,
  prev_touch_key,
  touch_key,
  prev_created_at,
  created_at,
  round(extract(epoch FROM (created_at - prev_created_at)) / 60.0, 2) AS minutes_between,
  left(coalesce(generated_text, ''), 120) AS generated_text_preview
FROM touches
WHERE prev_created_at IS NOT NULL
  AND created_at - prev_created_at <= interval '2 hours'
  AND prev_scenario <> scenario_code
ORDER BY created_at DESC
LIMIT 200;

-- ====================
-- 4) Row-level review set
-- ====================
SELECT
  touch_key,
  session_id,
  scenario_code,
  status,
  decision_reason,
  outcome_kind,
  created_at,
  fired_at,
  sent_at,
  batch_id,
  generated_text
FROM reengagement_touch_records
WHERE created_at >= now() - interval '3 days'
ORDER BY created_at DESC
LIMIT 500;
