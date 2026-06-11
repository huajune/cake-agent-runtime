-- 提取质量对账 RPC：booking 真值 vs 记忆提取值（逐字段覆盖率/准确率）。
--
-- 数据源：
--   真值侧：ops_events 的 booking.succeeded 事件 payload（candidate_name/phone/
--           candidate_age/candidate_gender）——booking 提交值是经业务校验的 ground truth。
--   提取侧：message_processing_records.memory_snapshot.sessionFacts——取该 chat 在 booking
--           发生前 2 小时内最近一轮的快照（即 Agent 发起 booking 时实际看到的记忆）。
--
-- 口径说明（与 scripts/extraction-accuracy-report.sql 一致，仅把固定 14 天窗参数化为 p_start/p_end）：
--   - covered  = 提取侧有值（无论对错）；coverage 低 → 该字段靠收资模板现收，提取层没贡献。
--   - matched  = 提取值与真值完全相等（trim 后）；accuracy 低 → 提取层在污染预填。
--   - age 真值是数字、提取值可能是 "37"/"37岁"，做了归一化。
--
-- 返回每字段一行：field/bookings/extracted/coverage_pct/accuracy_pct/mismatches/high_conf/high_conf_accuracy_pct。
CREATE OR REPLACE FUNCTION extraction_accuracy_report(
  p_start timestamptz,
  p_end timestamptz
)
RETURNS TABLE (
  field text,
  bookings bigint,
  extracted bigint,
  coverage_pct numeric,
  accuracy_pct numeric,
  mismatches bigint,
  high_conf bigint,
  high_conf_accuracy_pct numeric
)
LANGUAGE sql
STABLE
AS $$
  WITH bookings AS (
    SELECT
      chat_id,
      occurred_at,
      payload->>'candidate_name'   AS truth_name,
      payload->>'phone'            AS truth_phone,
      payload->>'candidate_age'    AS truth_age,
      payload->>'candidate_gender' AS truth_gender
    FROM ops_events
    WHERE event_name = 'booking.succeeded'
      AND occurred_at >= p_start
      AND occurred_at < p_end
      AND payload ? 'candidate_age'   -- 只取新版事件（含对账字段）
  ),
  snapshot AS (
    -- booking 前该 chat 最近一轮的记忆快照（Agent 发起 booking 时看到的事实）
    SELECT DISTINCT ON (b.chat_id, b.occurred_at)
      b.*,
      m.memory_snapshot->'sessionFacts' AS facts
    FROM bookings b
    JOIN message_processing_records m
      ON m.chat_id = b.chat_id
     AND m.created_at <= b.occurred_at
     AND m.created_at >= b.occurred_at - interval '2 hours'
     AND jsonb_typeof(m.memory_snapshot->'sessionFacts') = 'object'
    ORDER BY b.chat_id, b.occurred_at, m.created_at DESC
  ),
  extracted AS (
    SELECT
      *,
      -- sessionFacts 字段可能是 {value,...} 包裹，也可能是裸值（旧数据）
      COALESCE(facts->'interview.name'->>'value',   facts->>'interview.name')   AS ext_name,
      COALESCE(facts->'interview.phone'->>'value',  facts->>'interview.phone')  AS ext_phone,
      COALESCE(facts->'interview.age'->>'value',    facts->>'interview.age')    AS ext_age,
      COALESCE(facts->'interview.gender'->>'value', facts->>'interview.gender') AS ext_gender,
      facts->'interview.name'->>'confidence'  AS ext_name_conf,
      facts->'interview.phone'->>'confidence' AS ext_phone_conf,
      facts->'interview.age'->>'confidence'   AS ext_age_conf,
      facts->'interview.gender'->>'confidence' AS ext_gender_conf
    FROM snapshot
  ),
  per_field AS (
    SELECT t.field, t.truth, t.ext, t.conf,
      (t.ext IS NOT NULL AND btrim(t.ext) <> '') AS covered,
      CASE t.field
        WHEN 'age' THEN regexp_replace(COALESCE(t.ext, ''), '[^0-9]', '', 'g') = btrim(COALESCE(t.truth, ''))
        ELSE btrim(COALESCE(t.ext, '')) = btrim(COALESCE(t.truth, ''))
      END AS matched
    FROM extracted,
    LATERAL (VALUES
      ('name',   extracted.truth_name,   extracted.ext_name,   extracted.ext_name_conf),
      ('phone',  extracted.truth_phone,  extracted.ext_phone,  extracted.ext_phone_conf),
      ('age',    extracted.truth_age,    extracted.ext_age,    extracted.ext_age_conf),
      ('gender', extracted.truth_gender, extracted.ext_gender, extracted.ext_gender_conf)
    ) AS t(field, truth, ext, conf)
    WHERE t.truth IS NOT NULL AND btrim(t.truth) <> ''
  )
  SELECT
    pf.field,
    count(*)                                            AS bookings,
    count(*) FILTER (WHERE pf.covered)                  AS extracted,
    round(100.0 * count(*) FILTER (WHERE pf.covered) / count(*), 1)                    AS coverage_pct,
    round(100.0 * count(*) FILTER (WHERE pf.covered AND pf.matched)
          / NULLIF(count(*) FILTER (WHERE pf.covered), 0), 1)                          AS accuracy_pct,
    count(*) FILTER (WHERE pf.covered AND NOT pf.matched)     AS mismatches,
    count(*) FILTER (WHERE pf.covered AND pf.conf = 'high')   AS high_conf,
    round(100.0 * count(*) FILTER (WHERE pf.covered AND pf.conf = 'high' AND pf.matched)
          / NULLIF(count(*) FILTER (WHERE pf.covered AND pf.conf = 'high'), 0), 1)     AS high_conf_accuracy_pct
  FROM per_field pf
  GROUP BY pf.field
  ORDER BY pf.field;
$$;
