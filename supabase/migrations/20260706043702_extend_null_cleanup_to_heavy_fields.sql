-- 夜间 NULL 化清理扩展到 agent_steps / tool_calls
--
-- 背景：agent_invocation 7 天 NULL 化已生效，但 agent_steps(~6.6KB/行) 与
-- tool_calls(~4.4KB/行) 不在清理范围，随行保留满 30 天，合计约 200MB TOAST。
-- 排障时效上三者同源（都是 turn 级明细），统一走 DATA_CLEANUP_AGENT_INVOCATION_DAYS。
--
-- 函数名保持 null_agent_invocation 不变：应用侧
-- （message-processing.repository.ts 的分批循环）按此名调用，改名会造成
-- 迁移先行、应用未发版窗口内夜间清理断档。语义以 COMMENT ON FUNCTION 为准。
--
-- WHERE 条件按三列取 OR：存量 7~30 天行的 invocation 已为 NULL 但 steps 仍在，
-- 需要能被再次选中；分批 200 行/次由应用循环调用直到清完。

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
  SET agent_invocation = NULL,
      agent_steps = NULL,
      tool_calls = NULL
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE received_at < NOW() - (p_days_old || ' days')::interval
      AND (agent_invocation IS NOT NULL
        OR agent_steps IS NOT NULL
        OR tool_calls IS NOT NULL)
    ORDER BY received_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION null_agent_invocation(integer, integer) IS
  '分批 NULL 化过期 turn 级重字段（agent_invocation/agent_steps/tool_calls），释放 TOAST；函数名为历史兼容';
