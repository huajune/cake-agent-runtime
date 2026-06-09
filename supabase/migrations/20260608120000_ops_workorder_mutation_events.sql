-- ------------------------------------------------------------
-- 工单自助变更事件投影：booking.canceled / booking.interview_modified
--
-- 背景：新增「取消工单 / 修改约面时间」两个 Agent 工具，成功后写 ops_events 底账。
-- 本迁移把这两个事件接入 daily_ops_report 投影（与现有 13 个事件同一套 upsert_ops_event 机制）：
--   1) daily_ops_report 加两个计数列（period snapshot，当天事件数）
--   2) ops_event_projection_column 增加两条映射 → upsert_ops_event 的动态 +1 自动生效
--
-- 幂等：列用 IF NOT EXISTS；函数用 CREATE OR REPLACE。
-- ------------------------------------------------------------

ALTER TABLE daily_ops_report
  ADD COLUMN IF NOT EXISTS booking_cancel_count       integer NOT NULL DEFAULT 0,  -- booking.canceled
  ADD COLUMN IF NOT EXISTS interview_modified_count   integer NOT NULL DEFAULT 0;  -- booking.interview_modified

CREATE OR REPLACE FUNCTION ops_event_projection_column(p_event_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_event_name
    WHEN 'friend.added'               THEN 'friends_added_count'
    WHEN 'agent.opening_sent'         THEN 'agent_opening_sent_count'
    WHEN 'candidate.engaged'          THEN 'break_ice_count'
    WHEN 'candidate.message_received' THEN 'candidate_message_count'
    WHEN 'agent.replied'              THEN 'agent_reply_count'
    WHEN 'job.recommended'            THEN 'job_recommend_count'
    WHEN 'precheck.passed'            THEN 'precheck_pass_count'
    WHEN 'booking.succeeded'          THEN 'booking_success_count'
    WHEN 'booking.failed'             THEN 'booking_fail_count'
    WHEN 'group.invited'              THEN 'group_invite_count'
    WHEN 'handoff.triggered'          THEN 'handoff_count'
    WHEN 'interview.passed'           THEN 'interview_pass_count'
    WHEN 'booking.canceled'           THEN 'booking_cancel_count'
    WHEN 'booking.interview_modified' THEN 'interview_modified_count'
    -- candidate.hired 不投影 daily_ops_report（仅 Web cohort/KPI 读 ops_events）
    ELSE NULL
  END
$$;
