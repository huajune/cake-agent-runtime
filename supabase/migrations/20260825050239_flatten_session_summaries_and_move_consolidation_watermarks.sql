-- M5 深审裁定四：sessionSummaries 裸数组化，并把 consolidation 工作水位迁出记忆内容。
-- 存量不做全表回填：运行时读边界与下列两个写 RPC 都会懒迁移触达行。

CREATE OR REPLACE FUNCTION default_consolidation_watermarks()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '{"bySession": {}, "lastSettledMessageAt": null}'::jsonb
$$;

ALTER TABLE public.agent_long_term_memories
  ADD COLUMN consolidation_watermarks jsonb NOT NULL
  DEFAULT default_consolidation_watermarks();

COMMENT ON COLUMN public.agent_long_term_memories.consolidation_watermarks IS
  'consolidation 工作书签：bySession 按 chatId 幂等，lastSettledMessageAt 仅作旧行兼容回退；不属于 episodic 记忆内容';

ALTER TABLE public.agent_long_term_memories
  ALTER COLUMN episodic_session_summaries
  SET DEFAULT '[]'::jsonb;

-- 存量按读边界懒迁移，过渡期必须同时接受旧 object 与新 array；新写路径只产出 array。
ALTER TABLE public.agent_long_term_memories
  DROP CONSTRAINT agent_long_term_memories_summary_data_object;

ALTER TABLE public.agent_long_term_memories
  ADD CONSTRAINT agent_long_term_memories_session_summaries_shape
  CHECK (jsonb_typeof(episodic_session_summaries) IN ('array', 'object'));

CREATE OR REPLACE FUNCTION default_long_term_summary_data()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT '[]'::jsonb
$$;

-- 同名 RPC：追加 episode 与推进水位在一次行锁、一次 UPDATE 内原子完成。
-- 参数名 p_max_recent 正名为 p_max_session_summaries；类型签名不变，仍须显式 DROP。
DROP FUNCTION append_long_term_summary_atomic(text, text, text, jsonb, text, integer, text);

CREATE FUNCTION append_long_term_summary_atomic(
  p_corp_id text,
  p_user_id text,
  p_bot_user_id text,
  p_entry jsonb,
  p_last_settled_message_at text DEFAULT NULL,
  p_max_session_summaries integer DEFAULT 20,
  p_session_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  existing_summary jsonb;
  existing_watermarks jsonb;
  episodes_arr jsonb := '[]'::jsonb;
  legacy_recent jsonb := '[]'::jsonb;
  legacy_archive jsonb := '[]'::jsonb;
  legacy_by_session jsonb := '{}'::jsonb;
  current_by_session jsonb := '{}'::jsonb;
  legacy_fallback text;
  current_fallback text;
  existing_session_watermark text;
  episode_count integer;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;
  IF p_max_session_summaries < 1 THEN
    RAISE EXCEPTION 'p_max_session_summaries must be positive';
  END IF;
  IF jsonb_typeof(p_entry) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'p_entry must be a json object';
  END IF;

  INSERT INTO public.agent_long_term_memories (
    corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries,
    consolidation_watermarks
  )
  VALUES (
    p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    default_consolidation_watermarks()
  )
  ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

  SELECT
    COALESCE(episodic_session_summaries, default_long_term_summary_data()),
    COALESCE(consolidation_watermarks, default_consolidation_watermarks())
  INTO existing_summary, existing_watermarks
  FROM public.agent_long_term_memories
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
  FOR UPDATE;

  IF jsonb_typeof(existing_summary) = 'array' THEN
    episodes_arr := existing_summary;
  ELSE
    -- 旧 recent 是新到旧，反转为裸数组的旧到新顺序。
    IF jsonb_typeof(existing_summary -> 'recent') = 'array' THEN
      SELECT COALESCE(jsonb_agg(item ORDER BY ordinal DESC), '[]'::jsonb)
      INTO legacy_recent
      FROM jsonb_array_elements(existing_summary -> 'recent')
        WITH ORDINALITY AS recent_item(item, ordinal)
      WHERE jsonb_typeof(item) = 'object';
    END IF;

    -- 旧 archive 只有摘要文本，没有逐段标识符；补空标识符保持 SummaryEntry 形状。
    IF jsonb_typeof(existing_summary -> 'archive') = 'string' THEN
      IF NULLIF(BTRIM(existing_summary ->> 'archive'), '') IS NOT NULL THEN
        legacy_archive := jsonb_build_array(jsonb_build_object(
          'summary', existing_summary ->> 'archive',
          'sessionId', '',
          'startTime', '',
          'endTime', ''
        ));
      END IF;
    ELSIF jsonb_typeof(existing_summary -> 'archive') = 'array' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'summary', segment #>> '{}',
            'sessionId', '',
            'startTime', '',
            'endTime', ''
          )
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      INTO legacy_archive
      FROM jsonb_array_elements(existing_summary -> 'archive')
        WITH ORDINALITY AS archive_item(segment, ordinal)
      WHERE jsonb_typeof(segment) = 'string'
        AND NULLIF(BTRIM(segment #>> '{}'), '') IS NOT NULL;
    END IF;

    episodes_arr := legacy_archive || legacy_recent;
  END IF;

  IF jsonb_typeof(existing_summary -> 'lastSettledBySession') = 'object' THEN
    legacy_by_session := existing_summary -> 'lastSettledBySession';
  END IF;
  IF jsonb_typeof(existing_watermarks -> 'bySession') = 'object' THEN
    current_by_session := existing_watermarks -> 'bySession';
  END IF;
  legacy_fallback := NULLIF(existing_summary ->> 'lastSettledMessageAt', '');
  current_fallback := NULLIF(existing_watermarks ->> 'lastSettledMessageAt', '');
  existing_watermarks := jsonb_build_object(
    'bySession', legacy_by_session || current_by_session,
    'lastSettledMessageAt', COALESCE(current_fallback, legacy_fallback)
  );

  -- 同一 session 的相同/更旧边界不重复追加；并发任务也由行锁下的水位判定挡住。
  IF p_session_id IS NOT NULL AND p_last_settled_message_at IS NOT NULL THEN
    existing_session_watermark := existing_watermarks #>> ARRAY['bySession', p_session_id];
    IF existing_session_watermark IS NOT NULL
       AND existing_session_watermark::timestamptz >= p_last_settled_message_at::timestamptz
    THEN
      episode_count := jsonb_array_length(episodes_arr);
      IF episode_count > p_max_session_summaries THEN
        SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
        INTO episodes_arr
        FROM jsonb_array_elements(episodes_arr)
          WITH ORDINALITY AS episode_item(item, ordinal)
        WHERE ordinal > episode_count - p_max_session_summaries;
      END IF;

      UPDATE public.agent_long_term_memories
      SET
        episodic_session_summaries = episodes_arr,
        consolidation_watermarks = existing_watermarks,
        updated_at = now()
      WHERE corp_id = p_corp_id
        AND user_id = p_user_id
        AND bot_user_id = p_bot_user_id;

      RETURN jsonb_build_object(
        'written', false,
        'summaryCount', jsonb_array_length(episodes_arr)
      );
    END IF;
  END IF;

  episodes_arr := episodes_arr || jsonb_build_array(p_entry);
  episode_count := jsonb_array_length(episodes_arr);
  IF episode_count > p_max_session_summaries THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
    INTO episodes_arr
    FROM jsonb_array_elements(episodes_arr)
      WITH ORDINALITY AS episode_item(item, ordinal)
    WHERE ordinal > episode_count - p_max_session_summaries;
  END IF;

  IF p_last_settled_message_at IS NOT NULL THEN
    existing_watermarks := jsonb_set(
      existing_watermarks,
      '{lastSettledMessageAt}',
      to_jsonb(p_last_settled_message_at),
      true
    );
    IF p_session_id IS NOT NULL THEN
      existing_watermarks := jsonb_set(
        existing_watermarks,
        ARRAY['bySession', p_session_id],
        to_jsonb(p_last_settled_message_at),
        true
      );
    END IF;
  END IF;

  UPDATE public.agent_long_term_memories
  SET
    episodic_session_summaries = episodes_arr,
    consolidation_watermarks = existing_watermarks,
    updated_at = now()
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;

  RETURN jsonb_build_object(
    'written', true,
    'summaryCount', jsonb_array_length(episodes_arr)
  );
END;
$$;

-- 同名兼容 RPC：只推进水位时也顺带把触达行的旧摘要/旧水位迁到两列新结构。
DROP FUNCTION mark_long_term_settled_boundary(text, text, text, text, text);

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
  existing_watermarks jsonb;
  episodes_arr jsonb := '[]'::jsonb;
  legacy_recent jsonb := '[]'::jsonb;
  legacy_archive jsonb := '[]'::jsonb;
  legacy_by_session jsonb := '{}'::jsonb;
  current_by_session jsonb := '{}'::jsonb;
  legacy_fallback text;
  current_fallback text;
  episode_count integer;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;

  INSERT INTO public.agent_long_term_memories (
    corp_id,
    user_id,
    bot_user_id,
    semantic_profile,
    episodic_session_summaries,
    consolidation_watermarks
  )
  VALUES (
    p_corp_id,
    p_user_id,
    p_bot_user_id,
    default_long_term_profile_facts(),
    default_long_term_summary_data(),
    default_consolidation_watermarks()
  )
  ON CONFLICT (corp_id, user_id, bot_user_id) DO NOTHING;

  SELECT
    COALESCE(episodic_session_summaries, default_long_term_summary_data()),
    COALESCE(consolidation_watermarks, default_consolidation_watermarks())
  INTO existing_summary, existing_watermarks
  FROM public.agent_long_term_memories
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
  FOR UPDATE;

  IF jsonb_typeof(existing_summary) = 'array' THEN
    episodes_arr := existing_summary;
  ELSE
    IF jsonb_typeof(existing_summary -> 'recent') = 'array' THEN
      SELECT COALESCE(jsonb_agg(item ORDER BY ordinal DESC), '[]'::jsonb)
      INTO legacy_recent
      FROM jsonb_array_elements(existing_summary -> 'recent')
        WITH ORDINALITY AS recent_item(item, ordinal)
      WHERE jsonb_typeof(item) = 'object';
    END IF;

    IF jsonb_typeof(existing_summary -> 'archive') = 'string' THEN
      IF NULLIF(BTRIM(existing_summary ->> 'archive'), '') IS NOT NULL THEN
        legacy_archive := jsonb_build_array(jsonb_build_object(
          'summary', existing_summary ->> 'archive',
          'sessionId', '',
          'startTime', '',
          'endTime', ''
        ));
      END IF;
    ELSIF jsonb_typeof(existing_summary -> 'archive') = 'array' THEN
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'summary', segment #>> '{}',
            'sessionId', '',
            'startTime', '',
            'endTime', ''
          )
          ORDER BY ordinal
        ),
        '[]'::jsonb
      )
      INTO legacy_archive
      FROM jsonb_array_elements(existing_summary -> 'archive')
        WITH ORDINALITY AS archive_item(segment, ordinal)
      WHERE jsonb_typeof(segment) = 'string'
        AND NULLIF(BTRIM(segment #>> '{}'), '') IS NOT NULL;
    END IF;
    episodes_arr := legacy_archive || legacy_recent;
  END IF;

  episode_count := jsonb_array_length(episodes_arr);
  IF episode_count > 20 THEN
    SELECT COALESCE(jsonb_agg(item ORDER BY ordinal), '[]'::jsonb)
    INTO episodes_arr
    FROM jsonb_array_elements(episodes_arr)
      WITH ORDINALITY AS episode_item(item, ordinal)
    WHERE ordinal > episode_count - 20;
  END IF;

  IF jsonb_typeof(existing_summary -> 'lastSettledBySession') = 'object' THEN
    legacy_by_session := existing_summary -> 'lastSettledBySession';
  END IF;
  IF jsonb_typeof(existing_watermarks -> 'bySession') = 'object' THEN
    current_by_session := existing_watermarks -> 'bySession';
  END IF;
  legacy_fallback := NULLIF(existing_summary ->> 'lastSettledMessageAt', '');
  current_fallback := NULLIF(existing_watermarks ->> 'lastSettledMessageAt', '');
  existing_watermarks := jsonb_build_object(
    'bySession', legacy_by_session || current_by_session,
    'lastSettledMessageAt', COALESCE(current_fallback, legacy_fallback)
  );
  existing_watermarks := jsonb_set(
    existing_watermarks,
    '{lastSettledMessageAt}',
    to_jsonb(p_last_settled_message_at),
    true
  );
  IF p_session_id IS NOT NULL THEN
    existing_watermarks := jsonb_set(
      existing_watermarks,
      ARRAY['bySession', p_session_id],
      to_jsonb(p_last_settled_message_at),
      true
    );
  END IF;

  UPDATE public.agent_long_term_memories
  SET
    episodic_session_summaries = episodes_arr,
    consolidation_watermarks = existing_watermarks,
    updated_at = now()
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id;
END;
$$;
