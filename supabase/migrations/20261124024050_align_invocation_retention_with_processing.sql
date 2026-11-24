BEGIN;

-- Deleting the parent cascades to its snapshot, including when this RPC is called without arguments.
CREATE OR REPLACE FUNCTION public.cleanup_message_processing_records(days_to_keep integer DEFAULT 90)
RETURNS TABLE(deleted_count bigint) LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM public.message_processing_records
  WHERE received_at < now() - make_interval(days => days_to_keep);
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_expired_agent_invocations(
  p_days_old integer DEFAULT 90, p_limit integer DEFAULT 500
)
RETURNS integer LANGUAGE plpgsql AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.message_processing_invocations
  WHERE message_id IN (
    SELECT message_id FROM public.message_processing_invocations
    WHERE created_at < now() - make_interval(days => p_days_old)
    ORDER BY created_at
    LIMIT p_limit
  );
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$;

COMMENT ON TABLE public.message_processing_invocations IS
  '每条处理流水至多一条请求与响应快照。默认保留 90 天，删除主流水会级联删除快照。';
COMMENT ON FUNCTION public.cleanup_message_processing_records(integer) IS
  '按接收时间删除过期处理流水，默认保留 90 天。关联调用快照随主流水级联删除。';
COMMENT ON FUNCTION public.delete_expired_agent_invocations(integer, integer) IS
  '按创建时间分批删除到期的模型调用快照，默认保留 90 天。';

COMMIT;
