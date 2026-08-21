-- 治理二期 M2-B（A3）：长期记忆列名对齐 CoALA 类型词汇（2026-08-21 用户裁定）。
--   profile_facts        → semantic_profile
--   preference_facts     → semantic_job_intent
--   summary_data         → episodic_session_summaries
-- 同批重建三个引用这些列的 RPC：函数名与签名不变（外部契约保留，PostgREST 无重载风险），
-- 仅内部列引用更新；default_long_term_* 辅助函数名不变。
-- ⚠️ 生产 push 必须与代码发版同批（B2 裁定；只推迁移不发代码=事故源）。

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agent_long_term_memories' AND column_name = 'profile_facts') THEN
    ALTER TABLE agent_long_term_memories RENAME COLUMN profile_facts TO semantic_profile;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agent_long_term_memories' AND column_name = 'preference_facts') THEN
    ALTER TABLE agent_long_term_memories RENAME COLUMN preference_facts TO semantic_job_intent;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'agent_long_term_memories' AND column_name = 'summary_data') THEN
    ALTER TABLE agent_long_term_memories RENAME COLUMN summary_data TO episodic_session_summaries;
  END IF;
END $$;

-- ============ RPC 1/3：置信度守卫原子 upsert（签名不变，列引用更新） ============
CREATE OR REPLACE FUNCTION upsert_long_term_profile_facts(
  p_corp_id text,
  p_user_id text,
  p_profile_facts jsonb,
  p_message_metadata jsonb DEFAULT NULL,
  p_preference_facts jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing_profile_facts jsonb;
  merged_profile_facts jsonb;
  field_key text;
  incoming_fact jsonb;
  existing_fact jsonb;
  written_fields text[] := '{}';
  skipped_fields text[] := '{}';
  preference_written boolean := false;
  profile_fields text[] := ARRAY[
    'name', 'phone', 'gender', 'age',
    'is_student', 'education', 'has_health_certificate'
  ];
BEGIN
  INSERT INTO agent_long_term_memories (
    corp_id,
    user_id,
    semantic_profile,
    episodic_session_summaries,
    message_metadata
  )
  VALUES (
    p_corp_id,
    p_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    p_message_metadata
  )
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  SELECT COALESCE(semantic_profile, default_long_term_profile_facts())
  INTO existing_profile_facts
  FROM agent_long_term_memories
  WHERE corp_id = p_corp_id AND user_id = p_user_id
  FOR UPDATE;

  merged_profile_facts := default_long_term_profile_facts() || existing_profile_facts;

  FOREACH field_key IN ARRAY profile_fields LOOP
    IF NOT (p_profile_facts ? field_key) OR p_profile_facts->field_key = 'null'::jsonb THEN
      CONTINUE;
    END IF;

    incoming_fact := p_profile_facts->field_key;
    IF jsonb_typeof(incoming_fact) != 'object'
       OR NOT (incoming_fact ? 'value')
       OR incoming_fact->'value' = 'null'::jsonb
    THEN
      CONTINUE;
    END IF;

    IF NOT (incoming_fact ? 'updatedAt') THEN
      incoming_fact := jsonb_set(
        incoming_fact,
        '{updatedAt}',
        to_jsonb((now() AT TIME ZONE 'UTC')::text),
        true
      );
    END IF;

    existing_fact := merged_profile_facts->field_key;

    IF jsonb_typeof(existing_fact) = 'object'
       AND existing_fact->>'confidence' = 'high'
       AND long_term_profile_confidence_rank(COALESCE(incoming_fact->>'confidence', 'unknown')) < 3
    THEN
      skipped_fields := array_append(skipped_fields, field_key);
      CONTINUE;
    END IF;

    written_fields := array_append(written_fields, field_key);
    merged_profile_facts := jsonb_set(
      merged_profile_facts,
      ARRAY[field_key],
      incoming_fact,
      true
    );
  END LOOP;

  preference_written := p_preference_facts IS NOT NULL
    AND jsonb_typeof(p_preference_facts) = 'object'
    AND p_preference_facts != '{}'::jsonb;

  IF array_length(written_fields, 1) > 0
     OR p_message_metadata IS NOT NULL
     OR preference_written
  THEN
    UPDATE agent_long_term_memories
    SET
      semantic_profile = merged_profile_facts,
      semantic_job_intent = CASE
        WHEN preference_written THEN p_preference_facts
        ELSE semantic_job_intent
      END,
      message_metadata = COALESCE(p_message_metadata, message_metadata),
      updated_at = now()
    WHERE corp_id = p_corp_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'written_fields', to_jsonb(written_fields),
    'skipped_fields', to_jsonb(skipped_fields),
    'preference_written', to_jsonb(preference_written)
  );
END;
$$;

-- ============ RPC 2/3：摘要原子追加（签名不变，列引用更新） ============
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
    semantic_profile,
    episodic_session_summaries
  )
  VALUES (
    p_corp_id,
    p_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data()
  )
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  SELECT COALESCE(episodic_session_summaries, default_long_term_summary_data())
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
  SET episodic_session_summaries = existing_summary, updated_at = now()
  WHERE corp_id = p_corp_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'overflow', COALESCE(overflow_arr, '[]'::jsonb),
    'recentCount', jsonb_array_length(recent_arr)
  );
END;
$$;

-- ============ RPC 3/3：沉淀边界原子更新（签名不变，列引用更新） ============
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
    semantic_profile,
    episodic_session_summaries
  )
  VALUES (
    p_corp_id,
    p_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data()
  )
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  SELECT COALESCE(episodic_session_summaries, default_long_term_summary_data())
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
  SET episodic_session_summaries = existing_summary, updated_at = now()
  WHERE corp_id = p_corp_id AND user_id = p_user_id;
END;
$$;
