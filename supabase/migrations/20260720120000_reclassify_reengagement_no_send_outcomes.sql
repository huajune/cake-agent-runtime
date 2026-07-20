-- 复聊观测口径修正：业务上正常完成的“不发送”不属于系统失败。
--
-- 旧链路把所有 outcome != reply 统一写成 failed，导致 Agent 主动 skip、
-- 安全拦截、转人工和投递前业务跳过都被看板误报为异常。
-- reengagement_agent_error 是真实的生成调用异常，继续保留 failed。

UPDATE public.reengagement_touch_records
SET status = 'skipped'
WHERE status = 'failed'
  AND (
    outcome_kind IN ('guardrail_blocked', 'handoff', 'delivery_skipped')
    OR (
      outcome_kind = 'skipped'
      AND decision_reason IS NOT NULL
      AND decision_reason NOT IN ('reengagement_agent_error', 'composer_error')
    )
  )
  AND error IS NULL;

COMMENT ON COLUMN public.reengagement_touch_records.status IS
  '生命周期状态：scheduled/rescheduled(待触发) / skipped(业务决策未发送) / disabled/stopped/frequency_blocked/superseded/duplicate/shadow / sent(已投递) / failed(生成、入队或投递的真实异常) / unknown(投递状态不明)';
