-- M5：长期记忆关系从（企业、候选人）细化为（企业、候选人、稳定托管账号）。
-- bot_user_id 必须使用企微 wecomUserId；会轮换的 imBotId 仅可保留作事实血缘/排障字段。
--
-- 存量策略：
-- 1. 旧行保留 bot_user_id IS NULL，不删除、不再参与长期记忆召回；active_booking 继续只读写该行。
-- 2. 仅当记忆中的 session 血缘都能解析、且只对应一个 chat_messages.manager_name 时，
--    复制长期记忆到该稳定 bot 行；不复制 active_booking。
-- 3. 无血缘或多 bot 血缘的旧行保持冻结。

ALTER TABLE public.agent_long_term_memories
  ADD COLUMN bot_user_id text;

ALTER TABLE public.agent_long_term_memories
  DROP CONSTRAINT IF EXISTS agent_long_term_memories_user_unique;

ALTER TABLE public.agent_long_term_memories
  ADD CONSTRAINT agent_long_term_memories_relation_unique
  UNIQUE (corp_id, user_id, bot_user_id);

-- PostgreSQL 普通 UNIQUE 允许多个 NULL；active_booking 兼容行必须仍是一位候选人一行。
CREATE UNIQUE INDEX agent_long_term_memories_legacy_relation_unique
  ON public.agent_long_term_memories (corp_id, user_id)
  WHERE bot_user_id IS NULL;

CREATE INDEX idx_agent_long_term_memories_bot_relation
  ON public.agent_long_term_memories (bot_user_id, corp_id, user_id);

COMMENT ON COLUMN public.agent_long_term_memories.bot_user_id IS
  '稳定托管账号企微 wecomUserId；NULL 仅用于冻结存量记忆与共享 active_booking，运行时长期召回不得读取 NULL 行';

WITH legacy_session_refs AS (
  SELECT memory.id AS memory_id, session_ref.key AS session_id
  FROM public.agent_long_term_memories memory
  CROSS JOIN LATERAL jsonb_each_text(
    COALESCE(memory.episodic_session_summaries -> 'lastSettledBySession', '{}'::jsonb)
  ) AS session_ref
  WHERE memory.bot_user_id IS NULL

  UNION

  SELECT memory.id, summary_entry ->> 'sessionId'
  FROM public.agent_long_term_memories memory
  CROSS JOIN LATERAL jsonb_array_elements(
    COALESCE(memory.episodic_session_summaries -> 'recent', '[]'::jsonb)
  ) AS summary_entry
  WHERE memory.bot_user_id IS NULL
    AND NULLIF(BTRIM(summary_entry ->> 'sessionId'), '') IS NOT NULL

  UNION

  SELECT memory.id, profile_fact.value ->> 'originSessionId'
  FROM public.agent_long_term_memories memory
  CROSS JOIN LATERAL jsonb_each(COALESCE(memory.semantic_profile, '{}'::jsonb)) AS profile_fact
  WHERE memory.bot_user_id IS NULL
    AND NULLIF(BTRIM(profile_fact.value ->> 'originSessionId'), '') IS NOT NULL

  UNION

  SELECT memory.id, intent_fact.value ->> 'originSessionId'
  FROM public.agent_long_term_memories memory
  CROSS JOIN LATERAL jsonb_each(COALESCE(memory.semantic_job_intent, '{}'::jsonb)) AS intent_fact
  WHERE memory.bot_user_id IS NULL
    AND NULLIF(BTRIM(intent_fact.value ->> 'originSessionId'), '') IS NOT NULL
),
resolved_lineage AS (
  SELECT
    refs.memory_id,
    NULLIF(BTRIM(latest_message.manager_name), '') AS bot_user_id
  FROM legacy_session_refs refs
  JOIN LATERAL (
    SELECT message.manager_name
    FROM public.chat_messages message
    WHERE message.chat_id = refs.session_id
      AND NULLIF(BTRIM(message.manager_name), '') IS NOT NULL
    ORDER BY message.timestamp DESC
    LIMIT 1
  ) AS latest_message ON true
),
single_bot_lineage AS (
  SELECT memory_id, MIN(bot_user_id) AS bot_user_id
  FROM resolved_lineage
  GROUP BY memory_id
  HAVING COUNT(DISTINCT bot_user_id) = 1
)
INSERT INTO public.agent_long_term_memories (
  corp_id,
  user_id,
  bot_user_id,
  semantic_profile,
  semantic_job_intent,
  episodic_session_summaries,
  message_metadata,
  created_at,
  updated_at
)
SELECT
  memory.corp_id,
  memory.user_id,
  lineage.bot_user_id,
  memory.semantic_profile,
  memory.semantic_job_intent,
  memory.episodic_session_summaries,
  memory.message_metadata,
  memory.created_at,
  memory.updated_at
FROM public.agent_long_term_memories memory
JOIN single_bot_lineage lineage ON lineage.memory_id = memory.id
WHERE memory.bot_user_id IS NULL
ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

-- RPC 1/3：置信度守卫原子 upsert。必须 DROP 旧签名，避免 PostgREST 重载歧义。
DROP FUNCTION upsert_long_term_profile_facts(text, text, jsonb, jsonb, jsonb);

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
    'is_student', 'education', 'has_health_certificate'
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

-- RPC 2/3：摘要原子追加。
DROP FUNCTION append_long_term_summary_atomic(text, text, jsonb, text, integer, text);

CREATE FUNCTION append_long_term_summary_atomic(
  p_corp_id text,
  p_user_id text,
  p_bot_user_id text,
  p_entry jsonb,
  p_last_settled_message_at text DEFAULT NULL,
  p_max_recent integer DEFAULT 5,
  p_session_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary jsonb;
  recent_arr jsonb;
  new_length integer;
  overflow_arr jsonb;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;

  INSERT INTO agent_long_term_memories (
    corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries
  )
  VALUES (
    p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data()
  )
  ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

  SELECT COALESCE(episodic_session_summaries, default_long_term_summary_data())
  INTO existing_summary
  FROM agent_long_term_memories
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
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
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;

  RETURN jsonb_build_object(
    'overflow', COALESCE(overflow_arr, '[]'::jsonb),
    'recentCount', jsonb_array_length(recent_arr)
  );
END;
$$;

-- RPC 3/3：沉淀边界原子更新。函数名/JSON 字段名是受保护旧契约。
DROP FUNCTION mark_long_term_settled_boundary(text, text, text, text);

CREATE FUNCTION mark_long_term_settled_boundary(
  p_corp_id text,
  p_user_id text,
  p_bot_user_id text,
  p_last_settled_message_at text,
  p_session_id text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary jsonb;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;

  INSERT INTO agent_long_term_memories (
    corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries
  )
  VALUES (
    p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data()
  )
  ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

  SELECT COALESCE(episodic_session_summaries, default_long_term_summary_data())
  INTO existing_summary
  FROM agent_long_term_memories
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
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
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;
END;
$$;
