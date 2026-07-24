-- ============================================================
-- handoff_events 增加岗位数据缺口列
--
-- salary_admin_inquiry 类转人工本质是岗位数据缺失；missing_job_info
-- 记录候选人问到而岗位字段没有答案的信息点（jsonb 字符串数组，如
-- ["试用期","工作餐"]）。与 ops_events.payload.missing_job_info 同源，
-- 落底账便于按缺配字段聚合分析。
-- ============================================================

ALTER TABLE handoff_events
  ADD COLUMN IF NOT EXISTS missing_job_info jsonb;

COMMENT ON COLUMN handoff_events.missing_job_info IS
  '岗位数据缺口（salary_admin_inquiry）：候选人问到而岗位字段没有答案的信息点，jsonb 字符串数组';
