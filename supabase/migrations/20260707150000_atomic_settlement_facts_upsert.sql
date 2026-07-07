-- 沉淀写入原子化：profile_facts 与 preference_facts 合并为单 RPC 事务。
--
-- 背景：writeFromSettlement 此前先调 upsert_long_term_profile_facts（RPC），再单独
-- UPDATE preference_facts 列。两步之间失败（Supabase 抖动/熔断）会只写一半——
-- profile 落库而意向丢失，且外层 catch 吞掉后不再重试。
--
-- 方案：给 upsert_long_term_profile_facts 增加可选 p_preference_facts 参数，
-- 在同一函数（单事务、同一行锁）内完成两列写入。preference_facts 维持
-- 快照式整列覆盖语义（最新一段会话的意向赢，不做字段级累积）。
--
-- 注意：PostgreSQL 的 CREATE OR REPLACE 不能改函数签名（会产生重载导致 PostgREST
-- 二义性报错），必须先 DROP 旧签名。

DROP FUNCTION IF EXISTS upsert_long_term_profile_facts(text, text, jsonb, jsonb);

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
    profile_facts,
    summary_data,
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

  SELECT COALESCE(profile_facts, default_long_term_profile_facts())
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
      profile_facts = merged_profile_facts,
      preference_facts = CASE
        WHEN preference_written THEN p_preference_facts
        ELSE preference_facts
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
