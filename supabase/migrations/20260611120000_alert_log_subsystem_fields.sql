-- ============================================================
-- Migration: monitoring_error_logs 承载子系统告警
-- 2026-06-11
--
-- 背景：monitoring_error_logs 是 dashboard "今日错误" KPI、错误列表的唯一
-- 数据源，但此前只有消息处理失败链路（recordFailure→saveErrorLog）写入；
-- 子系统告警（群任务/Cron/Infra/Incident）只发飞书、不落库 → 告警群叮叮响、
-- dashboard 岁月静好。现让 AlertNotifierService.sendAlert 也持久化（含被节流的），
-- 需要这些新列承载告警来源与投递状态。
--
-- 全部 additive：老字段（error/alert_type）保留，老数据新列为 NULL 兼容。
-- message_id 改为可空：系统级告警没有 messageId。
-- ============================================================

ALTER TABLE monitoring_error_logs
  ALTER COLUMN message_id DROP NOT NULL;

ALTER TABLE monitoring_error_logs
  ADD COLUMN IF NOT EXISTS subsystem text,        -- AlertContext.source.subsystem（group-task/wecom/cron/infra…）
  ADD COLUMN IF NOT EXISTS component text,         -- AlertContext.source.component
  ADD COLUMN IF NOT EXISTS action text,            -- AlertContext.source.action
  ADD COLUMN IF NOT EXISTS severity text,          -- info | warning | error | critical
  ADD COLUMN IF NOT EXISTS summary text,           -- 短标题
  ADD COLUMN IF NOT EXISTS code text,              -- AlertContext.code
  ADD COLUMN IF NOT EXISTS dedupe_key text,        -- 节流去重键
  ADD COLUMN IF NOT EXISTS throttled boolean DEFAULT false,  -- 是否因节流未发送（仍入 KPI）
  ADD COLUMN IF NOT EXISTS delivered boolean DEFAULT false;  -- 飞书是否实际投递成功

CREATE INDEX IF NOT EXISTS idx_error_logs_subsystem
  ON monitoring_error_logs (subsystem, "timestamp" DESC);

COMMENT ON COLUMN monitoring_error_logs.subsystem IS '告警来源子系统；NULL 为老数据/消息处理失败';
COMMENT ON COLUMN monitoring_error_logs.throttled IS '被节流丢弃飞书但仍写表（高峰期 KPI 不被节流掩盖）';
COMMENT ON COLUMN monitoring_error_logs.delivered IS '飞书卡片是否实际投递成功';
