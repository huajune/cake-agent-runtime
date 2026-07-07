-- 防止 reengagement_touch_records.status 从结果态回退为待定态
--
-- 背景（2026-07-06 发版前 review）：record_reengagement_touch 的 status 是
-- "最后写入者胜"，注释要求"调用方保证状态推进顺序"，但调用方保证不了：
-- 1. Bull 同 jobId 重排程是静默 no-op（completed job 保留 7 天），而
--    trackScheduled 在 queue.add 后无条件落库——锚点事件重投递会把已完成
--    触达（sent/shadow/stopped）回退成永远不会再触发的 scheduled；
-- 2. delay=0 时 processor 的 trackSent 与 scheduler fire-and-forget 的
--    trackScheduled 存在落库竞态，后者后到同样回退终态。
--
-- 口径：scheduled / rescheduled 是待定态（rank 1），其余全部是结果态（rank 2）。
-- 结果态之间保留 last-writer-wins（sent→unknown 等核对路径需要），
-- 但待定态不得覆盖结果态。事件轨迹 events 不受影响，照常追加留痕。
CREATE OR REPLACE FUNCTION reengagement_touch_status_rank(p_status TEXT)
RETURNS INT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_status IN ('scheduled', 'rescheduled') THEN 1 ELSE 2 END;
$$;

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
  p_event JSONB DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO reengagement_touch_records (
    touch_key, session_id, user_id, corp_id, scenario_code,
    anchor_event_id, anchor_at, job_id,
    status, decision_reason, shadow,
    fire_at, scheduled_at, fired_at, sent_at,
    outcome_kind, generated_text, reserve_result, error, events
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
    COALESCE(jsonb_build_array(p_event), '[]'::jsonb)
  )
  ON CONFLICT (touch_key) DO UPDATE SET
    session_id      = COALESCE(NULLIF(EXCLUDED.session_id, ''), reengagement_touch_records.session_id),
    user_id         = COALESCE(EXCLUDED.user_id, reengagement_touch_records.user_id),
    corp_id         = COALESCE(EXCLUDED.corp_id, reengagement_touch_records.corp_id),
    scenario_code   = COALESCE(NULLIF(EXCLUDED.scenario_code, ''), reengagement_touch_records.scenario_code),
    anchor_event_id = COALESCE(EXCLUDED.anchor_event_id, reengagement_touch_records.anchor_event_id),
    anchor_at       = COALESCE(EXCLUDED.anchor_at, reengagement_touch_records.anchor_at),
    job_id          = COALESCE(EXCLUDED.job_id, reengagement_touch_records.job_id),
    -- 状态机守卫：待定态（scheduled/rescheduled）不得覆盖结果态
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
    events          = CASE
                        WHEN p_event IS NULL THEN reengagement_touch_records.events
                        ELSE reengagement_touch_records.events || jsonb_build_array(p_event)
                      END,
    updated_at      = now();
END;
$$;
