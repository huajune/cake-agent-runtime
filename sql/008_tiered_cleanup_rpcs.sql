-- ============================================
-- 分层清理 RPC 函数
-- Phase 1: NULL agent_invocation（7 天后，释放 TOAST 空间）
-- Phase 2: DELETE 整行（14 天后，由现有 cleanup_message_processing_records 处理）
-- ============================================

-- NULL 掉过期的 agent_invocation JSONB 字段
-- 保留行本身（统计字段不受影响），仅释放 TOAST 存储
CREATE OR REPLACE FUNCTION null_agent_invocation(p_days_old integer DEFAULT 7)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records
  SET agent_invocation = NULL
  WHERE received_at < NOW() - (p_days_old || ' days')::interval
    AND agent_invocation IS NOT NULL;

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION null_agent_invocation(integer)
IS '清空过期 agent_invocation JSONB（默认 7 天），释放 TOAST 空间但保留统计数据';
