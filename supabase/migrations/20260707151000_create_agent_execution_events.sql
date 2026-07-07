-- Agent 执行事件表：message_processing_records 的 trace 附属事件明细。
--
-- 只存结构化执行事实（模型降级、工具慢/错、agent error/end 等），不作为普通日志表使用。

CREATE TABLE IF NOT EXISTS agent_execution_events (
  id bigserial PRIMARY KEY,
  trace_id text,
  event_type text NOT NULL,
  user_id text,
  corp_id text,
  chat_id text,
  scenario text,
  caller_kind text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE agent_execution_events IS
  'Agent 执行链结构化事件：按 trace_id 关联 message_processing_records，用于 dashboard 下钻和 badcase 复盘';
COMMENT ON COLUMN agent_execution_events.trace_id IS
  '等于 message_processing_records.message_id / 聚合 batchId / 主动触达 batchId';
COMMENT ON COLUMN agent_execution_events.event_type IS
  '事件类型：agent_end / agent_error / model_fallback / tool_call / tool_error 等';
COMMENT ON COLUMN agent_execution_events.payload IS
  '事件专属结构化字段，不包含 trace/user/chat/scenario 等公共维度';

CREATE INDEX IF NOT EXISTS idx_agent_execution_events_trace_id
  ON agent_execution_events (trace_id);
CREATE INDEX IF NOT EXISTS idx_agent_execution_events_created_at
  ON agent_execution_events (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_execution_events_event_type
  ON agent_execution_events (event_type);

ALTER TABLE agent_execution_events ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_execution_events' AND policyname = 'Allow public read'
  ) THEN
    CREATE POLICY "Allow public read" ON agent_execution_events
      AS PERMISSIVE FOR SELECT TO public USING (true);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_execution_events' AND policyname = 'Service role insert'
  ) THEN
    CREATE POLICY "Service role insert" ON agent_execution_events
      AS PERMISSIVE FOR INSERT TO public
      WITH CHECK ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'agent_execution_events' AND policyname = 'Service role delete'
  ) THEN
    CREATE POLICY "Service role delete" ON agent_execution_events
      AS PERMISSIVE FOR DELETE TO public
      USING ((( SELECT auth.role() AS role) = 'service_role'::text));
  END IF;
END $$;

CREATE OR REPLACE FUNCTION cleanup_agent_execution_events(days_to_keep integer DEFAULT 60)
RETURNS TABLE(deleted_count bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_date timestamptz;
  result_count bigint;
BEGIN
  cutoff_date := now() - (days_to_keep || ' days')::interval;
  DELETE FROM agent_execution_events
  WHERE created_at < cutoff_date;
  GET DIAGNOSTICS result_count = ROW_COUNT;
  RETURN QUERY SELECT result_count;
END;
$$;

COMMENT ON FUNCTION cleanup_agent_execution_events(integer) IS
  '删除超过保留期的 Agent 执行事件；默认 60 天，与 message_processing_records 处理链窗口一致';
