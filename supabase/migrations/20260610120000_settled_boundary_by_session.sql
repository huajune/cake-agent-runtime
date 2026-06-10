-- append_long_term_summary_atomic 增加 p_session_id：沉淀时同步写 lastSettledBySession[sessionId]。
-- 背景与整体说明见 20260610115900_drop_old_append_summary_signature.sql。

CREATE OR REPLACE FUNCTION append_long_term_summary_atomic(
  p_corp_id text,
  p_user_id text,
  p_entry jsonb,
  p_last_settled_message_at text DEFAULT NULL,
  p_max_recent int DEFAULT 5,
  p_session_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary jsonb;
  recent_arr jsonb;
  new_length int;
  overflow_arr jsonb;
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

  recent_arr := COALESCE(existing_summary->'recent', '[]'::jsonb);
  recent_arr := p_entry || recent_arr;
  new_length := jsonb_array_length(recent_arr);
  overflow_arr := '[]'::jsonb;

  IF new_length > p_max_recent THEN
    SELECT jsonb_agg(elem)
    INTO overflow_arr
    FROM jsonb_array_elements(recent_arr) WITH ORDINALITY AS t(elem, idx)
    WHERE t.idx > p_max_recent;

    SELECT jsonb_agg(elem)
    INTO recent_arr
    FROM jsonb_array_elements(recent_arr) WITH ORDINALITY AS t(elem, idx)
    WHERE t.idx <= p_max_recent;
  END IF;

  existing_summary := jsonb_set(existing_summary, '{recent}', recent_arr);

  IF p_last_settled_message_at IS NOT NULL THEN
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
  END IF;

  UPDATE agent_long_term_memories
  SET summary_data = existing_summary, updated_at = now()
  WHERE corp_id = p_corp_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'overflow', COALESCE(overflow_arr, '[]'::jsonb),
    'recentCount', jsonb_array_length(recent_arr)
  );
END;
$$;
