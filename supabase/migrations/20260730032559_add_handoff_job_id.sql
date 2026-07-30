-- ============================================================
-- handoff_events 增加当轮岗位 job_id 列
--
-- 背景（2026-07-30 周度人工介入分析）：给运营的两张榜——「岗位数据缺口榜」
-- 与「满岗/容量信号榜」——都需要「该改哪个岗位」，但底账只有 work_order_id
-- （27 条 salary_admin_inquiry 仅 9 条有值，booking_capacity_full 全为 null）。
-- 当时只能侧路 join ops_events 回补：满岗榜 9/9 命中，缺口榜仅 9/27——纯咨询
-- 会话没走到 precheck/booking，事件流里从无岗位身份，补不出来。
--
-- 本列在 request_handoff 触发当轮直接落「当前焦点岗位」的 jobId，使两张榜
-- 100% 自助，无需侧路 join。
--
-- 语义：转人工当轮候选人正在聊的岗位；无焦点岗位（如纯闲聊、开场即转人工）
-- 时为 null，属正常缺失而非异常。
-- ============================================================

ALTER TABLE handoff_events
  ADD COLUMN IF NOT EXISTS job_id bigint;

COMMENT ON COLUMN handoff_events.job_id IS
  '转人工当轮的焦点岗位 jobId（来自会话记忆 currentFocusJob，兜底 activeBookingJobIds/工具入参）；无焦点岗位时为 null';

-- 运营两张榜按 job_id 聚合（GROUP BY job_id + 时间窗）；部分索引避开大量 null 行。
CREATE INDEX IF NOT EXISTS idx_handoff_events_job_id
  ON handoff_events (job_id)
  WHERE job_id IS NOT NULL;
