-- 二次触发追溯增强：投递批次关联 + 候选人身份透出
--
-- 1) reengagement_touch_records 加 batch_id：投递路径的主动回合会在
--    message_processing_records 落一行（message_id = batch_id），追溯页
--    "查看消息处理流水"按钮靠它跳转，打通触达 → 回合详情的排障链路。
-- 2) record_reengagement_touch 加 p_batch_id 参数（签名变更需 DROP 旧函数，
--    否则 PostgREST 遇到重载函数无法解析）；保留 120000 状态机守卫 +
--    140000 空事件修复。
-- 3) get_reengagement_candidate_overview 透出候选人微信昵称 + 接管 bot：
--    LATERAL 取该会话 chat_messages 最新一条的 candidate_name/manager_name/im_bot_id。

ALTER TABLE reengagement_touch_records ADD COLUMN IF NOT EXISTS batch_id TEXT;
COMMENT ON COLUMN reengagement_touch_records.batch_id IS '投递该触达的主动回合批次 ID（= message_processing_records.message_id/batch_id），shadow/未投递分支为空';

-- ── record_reengagement_touch：加 p_batch_id ──
DROP FUNCTION IF EXISTS record_reengagement_touch(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
  BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, JSONB
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
  p_batch_id TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reengagement_touch_records (
    touch_key, session_id, user_id, corp_id, scenario_code,
    anchor_event_id, anchor_at, job_id,
    status, decision_reason, shadow,
    fire_at, scheduled_at, fired_at, sent_at,
    outcome_kind, generated_text, reserve_result, error, batch_id, events
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
    events          = CASE
                        WHEN p_event IS NULL THEN reengagement_touch_records.events
                        ELSE reengagement_touch_records.events || jsonb_build_array(p_event)
                      END,
    updated_at      = now();
END;
$$;

-- ── get_reengagement_candidate_overview：透出候选人昵称 + 接管 bot ──
-- RETURNS TABLE 变更必须 DROP 再建
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
  -- 候选人身份：该会话最新一条聊天消息上的昵称/接管 bot（chat_messages 每条都带会话级身份）
  identities AS (
    SELECT p.sid,
           ident.candidate_name,
           ident.manager_name,
           ident.im_bot_id
      FROM paged p
      LEFT JOIN LATERAL (
        SELECT cm.candidate_name, cm.manager_name, cm.im_bot_id
          FROM chat_messages cm
         WHERE cm.chat_id = p.sid
         ORDER BY cm.timestamp DESC
         LIMIT 1
      ) ident ON TRUE
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
         i.im_bot_id AS bot_im_id
    FROM paged p
    JOIN latest l ON l.session_id = p.sid
    LEFT JOIN identities i ON i.sid = p.sid
   ORDER BY p.latest_at DESC, l.session_id, l.scenario_code;
$$;
