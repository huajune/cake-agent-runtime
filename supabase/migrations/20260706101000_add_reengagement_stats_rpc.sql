-- 二次触发追溯页顶部统计卡：按 status + scenario_code 分组计数（DB 侧聚合，避免全量拉行）

CREATE OR REPLACE FUNCTION get_reengagement_touch_stats(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ
) RETURNS TABLE (
  status TEXT,
  scenario_code TEXT,
  cnt BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT r.status, r.scenario_code, count(*) AS cnt
    FROM reengagement_touch_records r
   WHERE r.created_at >= p_start
     AND r.created_at < p_end
   GROUP BY r.status, r.scenario_code;
$$;
