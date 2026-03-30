-- Fix: only keep max_recommend_distance_km threshold
-- age_sensitive and insurance_promise are rules, not numeric thresholds

UPDATE strategy_config
SET red_lines = jsonb_set(
  red_lines,
  '{thresholds}',
  '[
    {
      "flag": "max_recommend_distance_km",
      "label": "推荐距离上限",
      "rule": "仅推荐距离范围内的门店，超出的不展示不提及",
      "max": 10,
      "unit": "km"
    }
  ]'::jsonb
)
WHERE is_active = true;
