-- 运营候选人视角只展示仍相关的当前态：
-- 每个 (session, scenario) 先取最新触达；若最新状态是 superseded，说明该场景已被新任务替代，
-- 不再把旧任务作为候选人列表/场景芯片展示，也不把它计入候选人分页总数。

CREATE OR REPLACE FUNCTION get_reengagement_candidate_overview(
  p_start TIMESTAMPTZ DEFAULT NULL,
  p_end TIMESTAMPTZ DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
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
  total_sessions BIGINT,
  candidate_name TEXT,
  manager_name TEXT,
  bot_im_id TEXT
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
  visible_latest AS (
    SELECT *
      FROM latest
     WHERE status <> 'superseded'
  ),
  sessions AS (
    SELECT l.session_id AS sid, max(l.updated_at) AS latest_at
      FROM visible_latest l
     WHERE (p_status IS NULL
            OR EXISTS (SELECT 1 FROM visible_latest st
                        WHERE st.session_id = l.session_id
                          AND st.status = p_status))
       AND (p_scenario_code IS NULL
            OR EXISTS (SELECT 1 FROM visible_latest s
                        WHERE s.session_id = l.session_id
                          AND s.scenario_code = p_scenario_code))
       AND (NOT p_pending_only
            OR EXISTS (SELECT 1 FROM visible_latest x
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
  ),
  identities AS (
    SELECT DISTINCT ON (l.session_id)
           l.session_id AS sid, l.candidate_name, l.manager_name, l.bot_im_id
      FROM latest l
     WHERE l.candidate_name IS NOT NULL OR l.manager_name IS NOT NULL OR l.bot_im_id IS NOT NULL
     ORDER BY l.session_id, l.updated_at DESC
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
         p.total AS total_sessions,
         i.candidate_name,
         i.manager_name,
         i.bot_im_id
    FROM paged p
    JOIN visible_latest l ON l.session_id = p.sid
    LEFT JOIN identities i ON i.sid = p.sid
   ORDER BY p.latest_at DESC, l.session_id, l.scenario_code;
$$;

DO $$
DECLARE
  fn REGPROCEDURE;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'get_reengagement_candidate_overview'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
