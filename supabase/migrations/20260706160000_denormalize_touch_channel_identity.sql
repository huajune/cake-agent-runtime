-- 触达追溯身份冗余落库：候选人昵称/接管 bot 在排程时写进 reengagement_touch_records，
-- 候选人视角查询直读本表列，不再查询期 LATERAL 关联 chat_messages。
--
-- 1) 加 candidate_name / manager_name / bot_im_id 三列；
-- 2) record_reengagement_touch 加对应参数（签名变更 DROP 重建，保留状态机守卫）；
-- 3) get_reengagement_candidate_overview 改为直读本表身份（每会话取最新非空快照）；
-- 4) 存量行一次性从 chat_messages 回填（此后不再依赖该关联）；
-- 5) 重新收紧新签名函数权限（对齐 151000 的 service_role-only 策略）。

ALTER TABLE reengagement_touch_records ADD COLUMN IF NOT EXISTS candidate_name TEXT;
ALTER TABLE reengagement_touch_records ADD COLUMN IF NOT EXISTS manager_name TEXT;
ALTER TABLE reengagement_touch_records ADD COLUMN IF NOT EXISTS bot_im_id TEXT;
COMMENT ON COLUMN reengagement_touch_records.candidate_name IS '候选人微信昵称（排程时冻结的渠道身份快照）';
COMMENT ON COLUMN reengagement_touch_records.manager_name IS '接管 bot 显示名（与 message_processing_records.manager_name 同口径 = botUserId）';
COMMENT ON COLUMN reengagement_touch_records.bot_im_id IS '接管 bot 系统 wxid';

-- ── record_reengagement_touch：加身份三参 ──
DROP FUNCTION IF EXISTS record_reengagement_touch(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
  BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT
);

CREATE OR REPLACE FUNCTION record_reengagement_touch(
  p_touch_key TEXT,
  p_session_id TEXT DEFAULT NULL,
  p_user_id TEXT DEFAULT NULL,
  p_corp_id TEXT DEFAULT NULL,
  p_scenario_code TEXT DEFAULT NULL,
  p_anchor_event_id TEXT DEFAULT NULL,
  p_anchor_at TIMESTAMPTZ DEFAULT NULL,
  p_job_id TEXT DEFAULT NULL,
  p_status TEXT DEFAULT NULL,
  p_decision_reason TEXT DEFAULT NULL,
  p_shadow BOOLEAN DEFAULT NULL,
  p_fire_at TIMESTAMPTZ DEFAULT NULL,
  p_scheduled_at TIMESTAMPTZ DEFAULT NULL,
  p_fired_at TIMESTAMPTZ DEFAULT NULL,
  p_sent_at TIMESTAMPTZ DEFAULT NULL,
  p_outcome_kind TEXT DEFAULT NULL,
  p_generated_text TEXT DEFAULT NULL,
  p_reserve_result TEXT DEFAULT NULL,
  p_error TEXT DEFAULT NULL,
  p_event JSONB DEFAULT NULL,
  p_batch_id TEXT DEFAULT NULL,
  p_candidate_name TEXT DEFAULT NULL,
  p_manager_name TEXT DEFAULT NULL,
  p_bot_im_id TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reengagement_touch_records (
    touch_key, session_id, user_id, corp_id, scenario_code,
    anchor_event_id, anchor_at, job_id,
    status, decision_reason, shadow,
    fire_at, scheduled_at, fired_at, sent_at,
    outcome_kind, generated_text, reserve_result, error, batch_id,
    candidate_name, manager_name, bot_im_id, events
  ) VALUES (
    p_touch_key,
    COALESCE(p_session_id, ''),
    p_user_id,
    p_corp_id,
    COALESCE(p_scenario_code, ''),
    p_anchor_event_id,
    p_anchor_at,
    p_job_id,
    COALESCE(p_status, 'scheduled'),
    p_decision_reason,
    p_shadow,
    p_fire_at,
    p_scheduled_at,
    p_fired_at,
    p_sent_at,
    p_outcome_kind,
    p_generated_text,
    p_reserve_result,
    p_error,
    p_batch_id,
    p_candidate_name,
    p_manager_name,
    p_bot_im_id,
    CASE WHEN p_event IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_event) END
  )
  ON CONFLICT (touch_key) DO UPDATE SET
    session_id      = COALESCE(NULLIF(EXCLUDED.session_id, ''), reengagement_touch_records.session_id),
    user_id         = COALESCE(EXCLUDED.user_id, reengagement_touch_records.user_id),
    corp_id         = COALESCE(EXCLUDED.corp_id, reengagement_touch_records.corp_id),
    scenario_code   = COALESCE(NULLIF(EXCLUDED.scenario_code, ''), reengagement_touch_records.scenario_code),
    anchor_event_id = COALESCE(EXCLUDED.anchor_event_id, reengagement_touch_records.anchor_event_id),
    anchor_at       = COALESCE(EXCLUDED.anchor_at, reengagement_touch_records.anchor_at),
    job_id          = COALESCE(EXCLUDED.job_id, reengagement_touch_records.job_id),
    -- 保留 20260706120000 的状态机守卫：待定态（scheduled/rescheduled）不得覆盖结果态
    status          = CASE
                        WHEN p_status IS NULL THEN reengagement_touch_records.status
                        WHEN reengagement_touch_status_rank(p_status) >=
                             reengagement_touch_status_rank(reengagement_touch_records.status)
                          THEN p_status
                        ELSE reengagement_touch_records.status
                      END,
    decision_reason = COALESCE(p_decision_reason, reengagement_touch_records.decision_reason),
    shadow          = COALESCE(p_shadow, reengagement_touch_records.shadow),
    fire_at         = COALESCE(p_fire_at, reengagement_touch_records.fire_at),
    scheduled_at    = COALESCE(p_scheduled_at, reengagement_touch_records.scheduled_at),
    fired_at        = COALESCE(p_fired_at, reengagement_touch_records.fired_at),
    sent_at         = COALESCE(p_sent_at, reengagement_touch_records.sent_at),
    outcome_kind    = COALESCE(p_outcome_kind, reengagement_touch_records.outcome_kind),
    generated_text  = COALESCE(p_generated_text, reengagement_touch_records.generated_text),
    reserve_result  = COALESCE(p_reserve_result, reengagement_touch_records.reserve_result),
    error           = COALESCE(p_error, reengagement_touch_records.error),
    batch_id        = COALESCE(p_batch_id, reengagement_touch_records.batch_id),
    candidate_name  = COALESCE(p_candidate_name, reengagement_touch_records.candidate_name),
    manager_name    = COALESCE(p_manager_name, reengagement_touch_records.manager_name),
    bot_im_id       = COALESCE(p_bot_im_id, reengagement_touch_records.bot_im_id),
    events          = CASE
                        WHEN p_event IS NULL THEN reengagement_touch_records.events
                        ELSE reengagement_touch_records.events || jsonb_build_array(p_event)
                      END,
    updated_at      = now();
END;
$$;

-- ── 存量回填（一次性）：从 chat_messages 补齐已有触达行的身份快照 ──
UPDATE reengagement_touch_records r
   SET candidate_name = ident.candidate_name,
       manager_name   = COALESCE(r.manager_name, ident.manager_name),
       bot_im_id      = COALESCE(r.bot_im_id, ident.im_bot_id)
  FROM (
    SELECT DISTINCT ON (cm.chat_id) cm.chat_id, cm.candidate_name, cm.manager_name, cm.im_bot_id
      FROM chat_messages cm
     WHERE cm.chat_id IN (
             SELECT DISTINCT session_id FROM reengagement_touch_records WHERE candidate_name IS NULL
           )
     ORDER BY cm.chat_id, cm.timestamp DESC
  ) ident
 WHERE ident.chat_id = r.session_id
   AND r.candidate_name IS NULL;

-- ── get_reengagement_candidate_overview：身份直读本表，去掉 chat_messages 关联 ──
DROP FUNCTION IF EXISTS get_reengagement_candidate_overview(
  TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, BOOLEAN, INT, INT
);

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
  ),
  -- 候选人身份：本表各行快照里取最新非空（写入时冻结，无跨表关联）
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
    JOIN latest l ON l.session_id = p.sid
    LEFT JOIN identities i ON i.sid = p.sid
   ORDER BY p.latest_at DESC, l.session_id, l.scenario_code;
$$;

-- ── 权限：新签名函数重新收紧（对齐 20260706151000 的 service_role-only 策略）──
DO $$
DECLARE
  fn REGPROCEDURE;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('record_reengagement_touch', 'get_reengagement_candidate_overview')
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
