-- M5 裁定五勘误：长期档案从 7 键扩为 9 键，加入 height / weight。
--
-- JSONB 列无需表结构迁移，但默认值函数、列默认值与 RPC 内部白名单均固定写死了
-- 旧七键。RPC 必须 DROP + CREATE，避免仅改应用类型后新键被静默忽略。

CREATE OR REPLACE FUNCTION default_long_term_profile_facts()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '{
    "name": null,
    "phone": null,
    "gender": null,
    "age": null,
    "is_student": null,
    "education": null,
    "has_health_certificate": null,
    "height": null,
    "weight": null
  }'::jsonb
$$;

ALTER TABLE public.agent_long_term_memories
  ALTER COLUMN semantic_profile SET DEFAULT default_long_term_profile_facts();

DROP FUNCTION upsert_long_term_profile_facts(text, text, text, jsonb, jsonb, jsonb);

CREATE FUNCTION upsert_long_term_profile_facts(
  p_corp_id text,
  p_user_id text,
  p_bot_user_id text,
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
    'is_student', 'education', 'has_health_certificate',
    'height', 'weight'
  ];
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;

  INSERT INTO agent_long_term_memories (
    corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries,
    message_metadata
  )
  VALUES (
    p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    p_message_metadata
  )
  ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

  SELECT COALESCE(semantic_profile, default_long_term_profile_facts())
  INTO existing_profile_facts
  FROM agent_long_term_memories
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
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
    WHERE corp_id = p_corp_id
      AND user_id = p_user_id
      AND bot_user_id = p_bot_user_id;
  END IF;

  RETURN jsonb_build_object(
    'written_fields', to_jsonb(written_fields),
    'skipped_fields', to_jsonb(skipped_fields),
    'preference_written', to_jsonb(preference_written)
  );
END;
$$;
