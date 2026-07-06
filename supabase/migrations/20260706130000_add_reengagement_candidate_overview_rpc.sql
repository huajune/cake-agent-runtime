-- 二次触发候选人视角：每个候选人（session）× 场景取最新一次触达，DB 侧聚合分页
--
-- 背景：追溯页原本只有流水视图（一行一次触达），运营想回答的问题是
-- "接下来会给哪些候选人发哪种复聊 / 某个候选人现在处于什么状态"，
-- 流水视图做不到。本 RPC 返回一页候选人的"各场景最新状态"行集，
-- 服务层按 session 分组组装成候选人卡片。
--
-- 语义：
-- - latest：每 (session_id, scenario_code) 取 updated_at 最新一行（当前态）
-- - 候选人排序：按其全场景最新活动时间倒序
-- - p_pending_only：只保留"有待发任务"的候选人（存在 scheduled/rescheduled 且 fire_at 未到）
-- - p_scenario_code：筛选"有该场景触达"的候选人，返回行仍含该候选人全部场景（看全貌）
-- - total_sessions：窗口计数，前端分页用

-- DISTINCT ON (session_id, scenario_code) ... ORDER BY updated_at DESC 的支撑索引
CREATE INDEX IF NOT EXISTS idx_reengagement_touch_session_scenario_updated
  ON reengagement_touch_records (session_id, scenario_code, updated_at DESC);

CREATE OR REPLACE FUNCTION get_reengagement_candidate_overview(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_scenario_code TEXT DEFAULT NULL,
  p_session_id TEXT DEFAULT NULL,
  p_pending_only BOOLEAN DEFAULT FALSE,
  p_limit INT DEFAULT 50,
  p_offset INT DEFAULT 0
) RETURNS TABLE (
  session_id TEXT,
  user_id TEXT,
  corp_id TEXT,
  scenario_code TEXT,
  touch_key TEXT,
  status TEXT,
  decision_reason TEXT,
  shadow BOOLEAN,
  fire_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  anchor_at TIMESTAMPTZ,
  outcome_kind TEXT,
  updated_at TIMESTAMPTZ,
  session_latest_at TIMESTAMPTZ,
  total_sessions BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (r.session_id, r.scenario_code) r.*
      FROM reengagement_touch_records r
     WHERE (p_start IS NULL OR r.updated_at >= p_start)
       AND (p_end IS NULL OR r.updated_at <= p_end)
       AND (p_session_id IS NULL OR r.session_id = p_session_id)
     ORDER BY r.session_id, r.scenario_code, r.updated_at DESC
  ),
  sessions AS (
    SELECT l.session_id AS sid, max(l.updated_at) AS latest_at
      FROM latest l
     WHERE (p_scenario_code IS NULL
            OR EXISTS (SELECT 1 FROM latest s
                        WHERE s.session_id = l.session_id
                          AND s.scenario_code = p_scenario_code))
       AND (NOT p_pending_only
            OR EXISTS (SELECT 1 FROM latest x
                        WHERE x.session_id = l.session_id
                          AND x.status IN ('scheduled', 'rescheduled')
                          AND x.fire_at > now()))
     GROUP BY l.session_id
  ),
  paged AS (
    SELECT sid, latest_at, count(*) OVER () AS total
      FROM sessions
     ORDER BY latest_at DESC
     LIMIT LEAST(GREATEST(p_limit, 1), 200) OFFSET GREATEST(p_offset, 0)
  )
  SELECT l.session_id,
         l.user_id,
         l.corp_id,
         l.scenario_code,
         l.touch_key,
         l.status,
         l.decision_reason,
         l.shadow,
         l.fire_at,
         l.sent_at,
         l.anchor_at,
         l.outcome_kind,
         l.updated_at,
         p.latest_at AS session_latest_at,
         p.total AS total_sessions
    FROM paged p
    JOIN latest l ON l.session_id = p.sid
   ORDER BY p.latest_at DESC, l.session_id, l.scenario_code;
$$;
