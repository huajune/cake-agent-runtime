-- 将消息处理链原始证据默认保留期从 30 天调整为 60 天。
--
-- message_processing_records 是处理链主账本；
-- guardrail_review_records 是按 trace_id 关联的稀疏附属证据。
-- 二者默认生命周期保持一致，避免主账本删除后留下孤儿全文证据。

CREATE OR REPLACE FUNCTION cleanup_message_processing_records(days_to_keep integer DEFAULT 60)
RETURNS TABLE(deleted_count bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_date timestamptz;
  result_count bigint;
BEGIN
  cutoff_date := now() - (days_to_keep || ' days')::interval;
  DELETE FROM message_processing_records
  WHERE received_at < cutoff_date;
  GET DIAGNOSTICS result_count = ROW_COUNT;
  RETURN QUERY SELECT result_count;
END;
$$;

COMMENT ON FUNCTION cleanup_message_processing_records(integer) IS
  '删除超过保留期的消息处理主流水；默认 60 天，处理链附属证据应先按同一窗口清理';

CREATE OR REPLACE FUNCTION cleanup_guardrail_review_records(days_to_keep integer DEFAULT 60)
RETURNS TABLE(deleted_count bigint)
LANGUAGE plpgsql
AS $$
DECLARE
  cutoff_date timestamptz;
  result_count bigint;
BEGIN
  cutoff_date := now() - (days_to_keep || ' days')::interval;
  DELETE FROM guardrail_review_records
  WHERE created_at < cutoff_date;
  GET DIAGNOSTICS result_count = ROW_COUNT;
  RETURN QUERY SELECT result_count;
END;
$$;

COMMENT ON FUNCTION cleanup_guardrail_review_records(integer) IS
  '删除超过保留期的出站守卫审查档案；默认 60 天，与 message_processing_records 处理链窗口一致';
