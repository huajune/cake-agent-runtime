-- Seed default business thresholds into the active strategy config's red_lines
-- These were previously hardcoded in DEFAULT_RED_LINES and removed in b18bc2d6

UPDATE strategy_config
SET red_lines = jsonb_set(
  COALESCE(red_lines, '{}'::jsonb),
  '{thresholds}',
  '[
    {
      "flag": "age_sensitive",
      "label": "年龄敏感",
      "rule": "候选人提及年龄/未成年/学生时，立即确认是否符合岗位要求，不满足则诚实告知不适合"
    },
    {
      "flag": "insurance_promise",
      "label": "保险承诺",
      "rule": "社保细节只说\"入职后按规定缴纳\"，具体引导到店确认，禁止承诺具体方案"
    },
    {
      "flag": "max_recommend_distance_km",
      "label": "推荐距离上限",
      "rule": "仅推荐距离范围内的门店，超出的不展示不提及",
      "max": 10,
      "unit": "km"
    }
  ]'::jsonb
)
WHERE is_active = true
  AND (red_lines IS NULL OR NOT red_lines ? 'thresholds' OR red_lines->'thresholds' = '[]'::jsonb);
