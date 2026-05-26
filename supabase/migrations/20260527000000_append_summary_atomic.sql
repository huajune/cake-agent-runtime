-- 原子化 appendSummary RPC：防止并发 detectAndSettle 读-改-写丢失摘要。
--
-- 场景：两次 detectAndSettle 并发执行时，应用层 read-then-write
-- 使后写者覆盖前者追加的摘要条目，静默丢失会话历史。
-- 此 RPC 使用 SELECT ... FOR UPDATE 行锁保证 summary_data 的原子追加。

CREATE OR REPLACE FUNCTION append_summary_atomic(
  p_corp_id TEXT,
  p_user_id TEXT,
  p_entry JSONB,
  p_last_settled_message_at TEXT DEFAULT NULL,
  p_max_recent INT DEFAULT 5
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary JSONB;
  recent_arr JSONB;
  new_length INT;
  overflow_arr JSONB;
BEGIN
  -- 确保行存在
  INSERT INTO agent_memories (corp_id, user_id, updated_at)
  VALUES (p_corp_id, p_user_id, NOW())
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  -- 锁定行并读取当前 summary_data
  SELECT COALESCE(summary_data, '{}'::JSONB)
  INTO existing_summary
  FROM agent_memories
  WHERE corp_id = p_corp_id AND user_id = p_user_id
  FOR UPDATE;

  -- 取出 recent 数组（默认空数组）
  recent_arr := COALESCE(existing_summary->'recent', '[]'::JSONB);

  -- 头部追加新条目
  recent_arr := p_entry || recent_arr;
  new_length := jsonb_array_length(recent_arr);

  -- 检查是否超限
  overflow_arr := '[]'::JSONB;
  IF new_length > p_max_recent THEN
    -- 提取溢出部分供调用方压缩
    SELECT jsonb_agg(elem)
    INTO overflow_arr
    FROM jsonb_array_elements(recent_arr) WITH ORDINALITY AS t(elem, idx)
    WHERE t.idx > p_max_recent;

    -- 截断 recent 到上限
    SELECT jsonb_agg(elem)
    INTO recent_arr
    FROM jsonb_array_elements(recent_arr) WITH ORDINALITY AS t(elem, idx)
    WHERE t.idx <= p_max_recent;
  END IF;

  -- 更新 summary_data
  existing_summary := jsonb_set(existing_summary, '{recent}', recent_arr);

  IF p_last_settled_message_at IS NOT NULL THEN
    existing_summary := jsonb_set(
      existing_summary,
      '{lastSettledMessageAt}',
      to_jsonb(p_last_settled_message_at)
    );
  END IF;

  UPDATE agent_memories
  SET summary_data = existing_summary, updated_at = NOW()
  WHERE corp_id = p_corp_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'overflow', COALESCE(overflow_arr, '[]'::JSONB),
    'recentCount', jsonb_array_length(recent_arr)
  );
END;
$$;
