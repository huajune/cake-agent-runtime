-- interrupt_stale_post_processing 子查询补 ORDER BY（code review 意见）：
-- LIMIT 不带排序时每批选取集合不确定；按收尾 startedAt 升序让同一批总是
-- 先标最早丢失的记录，利于排障回溯。语义不变，仅替换函数体。

CREATE OR REPLACE FUNCTION interrupt_stale_post_processing(
  p_stale_minutes integer DEFAULT 30,
  p_limit integer DEFAULT 200
)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  updated_count integer;
BEGIN
  UPDATE message_processing_records m
  SET post_processing_status = jsonb_set(
    m.post_processing_status,
    '{status}',
    '"interrupted"'
  ) || jsonb_build_object('interruptedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  WHERE m.id IN (
    SELECT id FROM message_processing_records
    WHERE post_processing_status->>'status' = 'running'
      -- 以收尾自身的 startedAt 判过期（updated_at 会被无关写入/触发器刷新，不可靠）
      AND COALESCE(
            (post_processing_status->>'startedAt')::timestamptz,
            updated_at
          ) < NOW() - (p_stale_minutes || ' minutes')::interval
    ORDER BY (post_processing_status->>'startedAt')::timestamptz NULLS LAST
    LIMIT p_limit
  );
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count;
END;
$$;
