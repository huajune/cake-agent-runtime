-- 提取质量对账报表：booking 真值 vs 记忆提取值（逐字段准确率/覆盖率）
--
-- 数据源：
--   真值侧：ops_events 的 booking.succeeded 事件 payload（candidate_name/phone/
--           candidate_age/candidate_gender/interview_time）——booking 提交值是
--           经业务校验的 ground truth（candidate_age/gender 自 2026-06-11 起落账）。
--   提取侧：message_processing_records.memory_snapshot.sessionFacts——取该 chat
--           在 booking 发生前最近一轮的快照（即 Agent 发起 booking 时实际看到的记忆）。
--
-- 口径说明：
--   - match    = 提取值与真值完全相等（trim 后）
--   - covered  = 提取侧有值（无论对错）；coverage 低 → 该字段靠收资模板现收，
--                提取层没贡献；accuracy 低 → 提取层在污染预填
--   - age 真值是数字、提取值可能是 "37"/"37岁"，做了归一化
--
-- 用法：在 Supabase SQL editor 或 psql 按需调整时间窗后执行。

WITH bookings AS (
  SELECT
    corp_id,
    chat_id,
    occurred_at,
    payload->>'candidate_name'   AS truth_name,
    payload->>'phone'            AS truth_phone,
    payload->>'candidate_age'    AS truth_age,
    payload->>'candidate_gender' AS truth_gender
  FROM ops_events
  WHERE event_name = 'booking.succeeded'
    AND occurred_at >= now() - interval '14 days'
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
  SELECT field, truth, ext, conf,
    (ext IS NOT NULL AND btrim(ext) <> '') AS covered,
    CASE field
      WHEN 'age' THEN regexp_replace(COALESCE(ext, ''), '[^0-9]', '', 'g') = btrim(COALESCE(truth, ''))
      ELSE btrim(COALESCE(ext, '')) = btrim(COALESCE(truth, ''))
    END AS matched
  FROM extracted,
  LATERAL (VALUES
    ('name',   truth_name,   ext_name,   ext_name_conf),
    ('phone',  truth_phone,  ext_phone,  ext_phone_conf),
    ('age',    truth_age,    ext_age,    ext_age_conf),
    ('gender', truth_gender, ext_gender, ext_gender_conf)
  ) AS t(field, truth, ext, conf)
  WHERE truth IS NOT NULL AND btrim(truth) <> ''
)
SELECT
  field,
  count(*)                                            AS bookings,
  count(*) FILTER (WHERE covered)                     AS extracted,
  round(100.0 * count(*) FILTER (WHERE covered) / count(*), 1)                    AS coverage_pct,
  round(100.0 * count(*) FILTER (WHERE covered AND matched)
        / NULLIF(count(*) FILTER (WHERE covered), 0), 1)                          AS accuracy_pct,
  count(*) FILTER (WHERE covered AND NOT matched)     AS mismatches,
  count(*) FILTER (WHERE covered AND conf = 'high')   AS high_conf,
  round(100.0 * count(*) FILTER (WHERE covered AND conf = 'high' AND matched)
        / NULLIF(count(*) FILTER (WHERE covered AND conf = 'high'), 0), 1)        AS high_conf_accuracy_pct
FROM per_field
GROUP BY field
ORDER BY field;

-- 排查不一致明细（按需取消注释）：
-- SELECT chat_id, occurred_at, field, truth, ext, conf
-- FROM per_field JOIN extracted USING (...)  -- 上面 CTE 内联出来查
-- WHERE covered AND NOT matched ORDER BY occurred_at DESC LIMIT 50;
