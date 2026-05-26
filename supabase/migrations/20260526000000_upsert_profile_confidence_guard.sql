-- 原子化置信度守卫 RPC：防止 settlement（medium）在并发场景下覆盖 booking（high）。
--
-- 场景：booking fire-and-forget 写入 high，settlement 异步写入 medium。
-- 如果两者交错（settlement 先读、booking 后写、settlement 最后落库），
-- 应用层 read-then-write 无法保证 high 不被 medium 覆盖。
-- 此 RPC 使用 SELECT ... FOR UPDATE 行锁保证原子性。

CREATE OR REPLACE FUNCTION upsert_profile_with_confidence_guard(
  p_corp_id TEXT,
  p_user_id TEXT,
  p_profile JSONB,
  p_meta JSONB,
  p_message_metadata JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  existing_meta JSONB;
  field_key TEXT;
  incoming_field_meta JSONB;
  existing_field_meta JSONB;
  merged_meta JSONB;
  written_fields TEXT[] := '{}';
  skipped_fields TEXT[] := '{}';
  profile_fields TEXT[] := ARRAY[
    'name', 'phone', 'gender', 'age',
    'is_student', 'education', 'has_health_certificate'
  ];
BEGIN
  -- 确保行存在（首次写入时创建），然后锁定
  INSERT INTO agent_memories (corp_id, user_id, updated_at)
  VALUES (p_corp_id, p_user_id, NOW())
  ON CONFLICT (corp_id, user_id) DO NOTHING;

  SELECT COALESCE(profile_fields_meta, '{}'::JSONB)
  INTO existing_meta
  FROM agent_memories
  WHERE corp_id = p_corp_id AND user_id = p_user_id
  FOR UPDATE;

  merged_meta := existing_meta;

  FOREACH field_key IN ARRAY profile_fields LOOP
    IF NOT (p_profile ? field_key) OR p_profile->field_key = 'null'::JSONB THEN
      CONTINUE;
    END IF;

    existing_field_meta := existing_meta->field_key;
    incoming_field_meta := p_meta->field_key;

    -- 置信度守卫：已有 high 时，非 high 不得覆盖
    IF existing_field_meta->>'confidence' = 'high'
       AND (incoming_field_meta IS NULL OR COALESCE(incoming_field_meta->>'confidence', '') != 'high')
    THEN
      skipped_fields := array_append(skipped_fields, field_key);
      CONTINUE;
    END IF;

    written_fields := array_append(written_fields, field_key);
    IF incoming_field_meta IS NOT NULL THEN
      merged_meta := jsonb_set(merged_meta, ARRAY[field_key], incoming_field_meta);
    END IF;
  END LOOP;

  IF array_length(written_fields, 1) > 0 THEN
    UPDATE agent_memories
    SET
      name                   = CASE WHEN 'name' = ANY(written_fields)                   THEN p_profile->>'name'                                    ELSE name END,
      phone                  = CASE WHEN 'phone' = ANY(written_fields)                  THEN p_profile->>'phone'                                   ELSE phone END,
      gender                 = CASE WHEN 'gender' = ANY(written_fields)                 THEN p_profile->>'gender'                                  ELSE gender END,
      age                    = CASE WHEN 'age' = ANY(written_fields)                    THEN p_profile->>'age'                                     ELSE age END,
      is_student             = CASE WHEN 'is_student' = ANY(written_fields)             THEN (p_profile->>'is_student')::BOOLEAN                   ELSE is_student END,
      education              = CASE WHEN 'education' = ANY(written_fields)              THEN p_profile->>'education'                               ELSE education END,
      has_health_certificate = CASE WHEN 'has_health_certificate' = ANY(written_fields) THEN p_profile->>'has_health_certificate'                  ELSE has_health_certificate END,
      profile_fields_meta    = merged_meta,
      message_metadata       = COALESCE(p_message_metadata, message_metadata),
      updated_at             = NOW()
    WHERE corp_id = p_corp_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'written_fields', to_jsonb(written_fields),
    'skipped_fields', to_jsonb(skipped_fields)
  );
END;
$$;
