-- ============================================================
-- 新长期记忆表：每用户一行，Profile facts + Summary jsonb
--
-- 说明：
-- - 不从旧 agent_memories 回填历史数据；历史倒迁后续单独执行。
-- - 运行时代码切到本表后，不再读取/写入 agent_memories 的画像列。
-- - profile_facts 内每个字段统一为：
--   { value, confidence, source, evidence, updatedAt } | null
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_long_term_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  corp_id text NOT NULL,
  user_id text NOT NULL,

  profile_facts jsonb NOT NULL DEFAULT '{
    "name": null,
    "phone": null,
    "gender": null,
    "age": null,
    "is_student": null,
    "education": null,
    "has_health_certificate": null
  }'::jsonb,

  summary_data jsonb NOT NULL DEFAULT '{
    "recent": [],
    "archive": null,
    "lastSettledMessageAt": null
  }'::jsonb,

  message_metadata jsonb,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_long_term_memories_user_unique UNIQUE (corp_id, user_id),
  CONSTRAINT agent_long_term_memories_profile_facts_object
    CHECK (jsonb_typeof(profile_facts) = 'object'),
  CONSTRAINT agent_long_term_memories_summary_data_object
    CHECK (jsonb_typeof(summary_data) = 'object')
);

CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_user
  ON agent_long_term_memories (corp_id, user_id);

CREATE INDEX IF NOT EXISTS idx_agent_long_term_memories_updated_at
  ON agent_long_term_memories (updated_at DESC);

CREATE OR REPLACE FUNCTION update_agent_long_term_memories_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_agent_long_term_memories_updated_at
  ON agent_long_term_memories;

CREATE TRIGGER trigger_agent_long_term_memories_updated_at
  BEFORE UPDATE ON agent_long_term_memories
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_long_term_memories_updated_at();

ALTER TABLE agent_long_term_memories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Service role full access on agent_long_term_memories"
  ON agent_long_term_memories;

CREATE POLICY "Service role full access on agent_long_term_memories"
  ON agent_long_term_memories
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE OR REPLACE FUNCTION long_term_profile_confidence_rank(confidence text)
RETURNS int
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE confidence
    WHEN 'high' THEN 3
    WHEN 'medium' THEN 2
    WHEN 'low' THEN 1
    ELSE 0
  END
$$;

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
    "has_health_certificate": null
  }'::jsonb
$$;

CREATE OR REPLACE FUNCTION default_long_term_summary_data()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '{
    "recent": [],
    "archive": null,
    "lastSettledMessageAt": null
  }'::jsonb
$$;

-- 原子化写入长期画像字段事实。
-- 规则：已有 high 时，incoming 非 high 不得覆盖。
CREATE OR REPLACE FUNCTION upsert_long_term_profile_facts(
  p_corp_id text,
  p_user_id text,
  p_profile_facts jsonb,
  p_message_metadata jsonb DEFAULT NULL
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

  IF array_length(written_fields, 1) > 0 OR p_message_metadata IS NOT NULL THEN
    UPDATE agent_long_term_memories
    SET
      profile_facts = merged_profile_facts,
      message_metadata = COALESCE(p_message_metadata, message_metadata),
      updated_at = now()
    WHERE corp_id = p_corp_id AND user_id = p_user_id;
  END IF;

  RETURN jsonb_build_object(
    'written_fields', to_jsonb(written_fields),
    'skipped_fields', to_jsonb(skipped_fields)
  );
END;
$$;

-- 原子化追加长期摘要。
CREATE OR REPLACE FUNCTION append_long_term_summary_atomic(
  p_corp_id text,
  p_user_id text,
  p_entry jsonb,
  p_last_settled_message_at text DEFAULT NULL,
  p_max_recent int DEFAULT 5
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
