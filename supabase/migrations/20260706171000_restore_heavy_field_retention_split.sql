-- 恢复 turn 级重字段的差异化保留期：仅 agent_invocation 走 7 天 NULL 化，
-- agent_steps / tool_calls 随行保留满 30 天（由行删除统一回收）
--
-- 背景：20260706043702 把 agent_steps / tool_calls 并入 7 天 NULL 化，
-- 但这两列是「30 天窗口」消费方的一手数据，提前 NULL 会静默破坏下游：
--   1. get_dashboard_tool_stats（20260529142000）直接
--      jsonb_array_elements(m.tool_calls) 且带 tool_calls IS NOT NULL 过滤 ——
--      被 NULL 化的行整行不计入，工具调用统计随保留期塌陷；
--      analytics-dashboard.service.ts 在小时投影缺失/过期时会对最长 30 天
--      区间回退到该 RPC（工具统计兜底路径）。
--   2. badcase 分析 skill（queries/latest-chats.sql）以 tool_calls 作为
--      30 天分析窗口内的主要判例证据，7 天后即无证可查。
-- agent_invocation（完整请求/响应快照，单行最重）不在任何 >7 天读取路径上，
-- 维持 7 天 NULL 化不变。
--
-- 函数名与签名保持 null_agent_invocation(p_days_old, p_limit) 不变，
-- 应用侧（message-processing.repository.ts 的分批循环）无需发版即生效。
-- 迁移生效前已被误 NULL 的存量 agent_steps / tool_calls 无法恢复，接受损失。

CREATE OR REPLACE FUNCTION null_agent_invocation(
  p_days_old integer DEFAULT 7,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records m
  SET agent_invocation = NULL
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE received_at < NOW() - (p_days_old || ' days')::interval
      AND agent_invocation IS NOT NULL
    ORDER BY received_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION null_agent_invocation(integer, integer) IS
  '分批 NULL 化过期 agent_invocation（释放 TOAST）；agent_steps/tool_calls 供 30 天窗口消费方（工具统计兜底 RPC + badcase 证据）使用，随行保留到 30 天行删除，勿并入本函数提前清理';
