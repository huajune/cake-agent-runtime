-- 复聊触达追溯：停发上下文 + 周度漏斗（PRD R1 改动 7）
--
-- 1) reengagement_touch_records 加 stop_context JSONB：触发停发的那条消息/证据
--    （候选人待答闸的候选人消息、聊天约定时间≠工单时间的两个时间与证据），
--    运营抽样核对停止原因时直接看这一列，不必翻聊天记录。
-- 2) record_reengagement_touch 加 p_stop_context 参数（签名变更需 DROP 旧函数，
--    否则 PostgREST 遇到重载函数无法解析）；保留 120000 状态机守卫与身份 COALESCE 语义。
-- 3) 新增 get_reengagement_weekly_funnel：按创建周（Asia/Shanghai）分组的
--    登记 → 发出 → 6h 内候选人回复 漏斗。cohort 按 created_at 所在周，投递/回复归入同一 cohort。
--    只读 created_at 范围（有索引），6h 回复用 chat_messages(chat_id, timestamp) 复合索引
--    做 EXISTS，仅对 sent 行触发；不展开 events / generated_text。

ALTER TABLE reengagement_touch_records ADD COLUMN IF NOT EXISTS stop_context JSONB;
COMMENT ON COLUMN reengagement_touch_records.stop_context IS
  '触发停发的上下文：pending_candidate_message 为候选人待答消息（时间/预览），chat_interview_time_mismatch 为工单时间、聊天约定时间与证据；其余原因为空';

-- ── record_reengagement_touch：加 p_stop_context ──
DROP FUNCTION IF EXISTS record_reengagement_touch(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
  BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, JSONB,
  TEXT, TEXT, TEXT, TEXT
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
  p_bot_im_id TEXT DEFAULT NULL,
  p_stop_context JSONB DEFAULT NULL
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
    candidate_name, manager_name, bot_im_id, stop_context, events
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
    p_stop_context,
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
    stop_context    = COALESCE(p_stop_context, reengagement_touch_records.stop_context),
    events          = CASE
                        WHEN p_event IS NULL THEN reengagement_touch_records.events
                        ELSE reengagement_touch_records.events || jsonb_build_array(p_event)
                      END,
    updated_at      = now();
END;
$$;

-- 新签名函数权限对齐 151000（service_role-only）
REVOKE ALL ON FUNCTION record_reengagement_touch(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
  BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, JSONB,
  TEXT, TEXT, TEXT, TEXT, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_reengagement_touch(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TIMESTAMPTZ, TEXT, TEXT, TEXT,
  BOOLEAN, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, TEXT, TEXT, TEXT, JSONB,
  TEXT, TEXT, TEXT, TEXT, JSONB
) TO service_role;

-- ── 周度漏斗：登记 → 发出 → 6h 内候选人回复 ──
-- 登记 = 该周创建的触达记录（剔除 signup_interview_gap_lt_3d 等「不适用」底账，与统计卡口径一致）；
-- 发出 = 其中 status=sent；6h 回复 = 发出后 6 小时内 chat_messages 出现候选人（role=user）消息。
-- 调用方限制范围 ≤ 13 周；created_at 走 idx_reengagement_touch_created，
-- EXISTS 走 idx_chat_messages_chat_id(chat_id, timestamp DESC)，只对 sent 行求值。
DROP FUNCTION IF EXISTS get_reengagement_weekly_funnel(TIMESTAMPTZ, TIMESTAMPTZ);

CREATE OR REPLACE FUNCTION get_reengagement_weekly_funnel(
  p_start TIMESTAMPTZ,
  p_end TIMESTAMPTZ
) RETURNS TABLE (
  week_start DATE,
  scenario_code TEXT,
  registered BIGINT,
  sent BIGINT,
  replied_6h BIGINT
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    (date_trunc('week', r.created_at AT TIME ZONE 'Asia/Shanghai'))::date AS week_start,
    r.scenario_code,
    count(*) AS registered,
    count(*) FILTER (WHERE r.status = 'sent') AS sent,
    count(*) FILTER (
      WHERE r.status = 'sent'
        AND r.sent_at IS NOT NULL
        AND EXISTS (
          SELECT 1
            FROM chat_messages cm
           WHERE cm.chat_id = r.session_id
             AND cm.role = 'user'
             AND cm.timestamp > r.sent_at
             AND cm.timestamp <= r.sent_at + interval '6 hours'
        )
    ) AS replied_6h
    FROM reengagement_touch_records r
   WHERE r.created_at >= p_start
     AND r.created_at < p_end
     AND COALESCE(r.decision_reason, '') <> 'signup_interview_gap_lt_3d'
   GROUP BY 1, 2
   ORDER BY 1, 2;
$$;

REVOKE ALL ON FUNCTION get_reengagement_weekly_funnel(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION get_reengagement_weekly_funnel(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
