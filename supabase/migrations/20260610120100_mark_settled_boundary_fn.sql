-- 沉淀边界原子更新（冷启动初始化 / 无摘要场景）。
CREATE OR REPLACE FUNCTION mark_long_term_settled_boundary(
  p_corp_id text,
  p_user_id text,
  p_last_settled_message_at text,
  p_session_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary jsonb;
BEGIN
  INSERT INTO agent_long_term_memories (
    corp_id,
    user_id,
    profile_facts,
    summary_data
  )
  VALUES (
    p_corp_id,
    p_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data()
  )
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  SELECT COALESCE(summary_data, default_long_term_summary_data())
  INTO existing_summary
  FROM agent_long_term_memories
  WHERE corp_id = p_corp_id AND user_id = p_user_id
  FOR UPDATE;

  existing_summary := jsonb_set(
    existing_summary,
    '{lastSettledMessageAt}',
    to_jsonb(p_last_settled_message_at)
  );

  IF p_session_id IS NOT NULL THEN
    existing_summary := jsonb_set(
      jsonb_set(
        existing_summary,
        '{lastSettledBySession}',
        COALESCE(existing_summary->'lastSettledBySession', '{}'::jsonb)
      ),
      ARRAY['lastSettledBySession', p_session_id],
      to_jsonb(p_last_settled_message_at)
    );
  END IF;

  UPDATE agent_long_term_memories
  SET summary_data = existing_summary, updated_at = now()
  WHERE corp_id = p_corp_id AND user_id = p_user_id;
END;
$$;
