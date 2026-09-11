-- 长期记忆存量形态一次性归一，配合读边界兼容层下线（PR fix/memory-quality-0911）。
--
-- 2026-09-11 生产核对：episodic_session_summaries 仍为旧对象形态 { recent, archive,
-- lastSettledBySession, lastSettledMessageAt } 的行 24,311；semantic_profile 旧 source
-- booking / extraction 共 8,886 条事实、semantic_job_intent 旧 source extraction 4,134 条。
-- 读边界懒迁移只在行被读到时才改写，这些行从未被读，永远留在旧形态。
--
-- 幂等：每条 UPDATE 只命中仍是旧形态的行，重跑为 0 行。
-- 语义与 supabase.store.ts normalizeEpisodicState（本 PR 删除前的版本）一致：
--   摘要 = [archive 段（空标识符）] ++ reverse(recent)（旧到新）；
--   水位 = 旧对象内 lastSettledBySession 并入独立列 bySession（独立列已有值优先），
--          lastSettledMessageAt 取独立列已有值，否则取旧对象内的值。

-- 1. 旧对象形态摘要 → 裸数组 + 独立水位列
UPDATE public.agent_long_term_memories AS m
SET
  episodic_session_summaries = COALESCE(
    (
      SELECT jsonb_agg(x.entry ORDER BY x.ord)
      FROM (
        SELECT 0 AS ord,
               jsonb_build_object(
                 'summary', BTRIM(m.episodic_session_summaries ->> 'archive'),
                 'sessionId', '',
                 'startTime', '',
                 'endTime', ''
               ) AS entry
        WHERE jsonb_typeof(m.episodic_session_summaries -> 'archive') = 'string'
          AND BTRIM(m.episodic_session_summaries ->> 'archive') <> ''
        UNION ALL
        SELECT jsonb_array_length(m.episodic_session_summaries -> 'recent') - r.idx + 1 AS ord,
               r.entry
        FROM jsonb_array_elements(
               CASE WHEN jsonb_typeof(m.episodic_session_summaries -> 'recent') = 'array'
                    THEN m.episodic_session_summaries -> 'recent'
                    ELSE '[]'::jsonb END
             ) WITH ORDINALITY AS r(entry, idx)
        WHERE jsonb_typeof(r.entry) = 'object'
          AND jsonb_typeof(r.entry -> 'summary') = 'string'
      ) AS x
    ),
    '[]'::jsonb
  ),
  consolidation_watermarks = jsonb_build_object(
    'bySession',
    COALESCE(
      (
        SELECT jsonb_object_agg(legacy.k, legacy.v)
        FROM jsonb_each_text(
               CASE WHEN jsonb_typeof(m.episodic_session_summaries -> 'lastSettledBySession') = 'object'
                    THEN m.episodic_session_summaries -> 'lastSettledBySession'
                    ELSE '{}'::jsonb END
             ) AS legacy(k, v)
        WHERE BTRIM(legacy.v) <> ''
      ),
      '{}'::jsonb
    )
    || COALESCE(
      CASE WHEN jsonb_typeof(m.consolidation_watermarks -> 'bySession') = 'object'
           THEN m.consolidation_watermarks -> 'bySession'
           ELSE '{}'::jsonb END,
      '{}'::jsonb
    ),
    'lastSettledMessageAt',
    COALESCE(
      CASE WHEN jsonb_typeof(m.consolidation_watermarks -> 'lastSettledMessageAt') = 'string'
           THEN m.consolidation_watermarks -> 'lastSettledMessageAt' END,
      CASE WHEN jsonb_typeof(m.episodic_session_summaries -> 'lastSettledMessageAt') = 'string'
           THEN m.episodic_session_summaries -> 'lastSettledMessageAt' END,
      'null'::jsonb
    )
  ),
  updated_at = now()
WHERE jsonb_typeof(m.episodic_session_summaries) = 'object';

-- 2. 摘要列从此只允许裸数组
ALTER TABLE public.agent_long_term_memories
  DROP CONSTRAINT IF EXISTS agent_long_term_memories_session_summaries_shape;
ALTER TABLE public.agent_long_term_memories
  ADD CONSTRAINT agent_long_term_memories_session_summaries_shape
  CHECK (jsonb_typeof(episodic_session_summaries) = 'array');

-- 3. 旧 source 词表 → 六章根词汇（映射同 long-term.types.ts 已删除的 LEGACY_PROFILE_FACT_PRODUCERS）
CREATE FUNCTION pg_temp.canonical_fact_producer(src text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE src
    WHEN 'candidate'  THEN 'candidate_quote'
    WHEN 'llm'        THEN 'model'
    WHEN 'memory'     THEN 'archive'
    WHEN 'derived'    THEN 'rule'
    WHEN 'tool'       THEN 'system'
    WHEN 'booking'    THEN 'system'
    WHEN 'extraction' THEN 'archive'
    WHEN 'enrichment' THEN 'system'
    ELSE src
  END
$$;

UPDATE public.agent_long_term_memories AS m
SET
  semantic_profile = (
    SELECT jsonb_object_agg(
             f.k,
             CASE WHEN jsonb_typeof(f.v) = 'object' AND jsonb_typeof(f.v -> 'source') = 'string'
                  THEN f.v || jsonb_build_object('source', pg_temp.canonical_fact_producer(f.v ->> 'source'))
                  ELSE f.v END
           )
    FROM jsonb_each(m.semantic_profile) AS f(k, v)
  ),
  updated_at = now()
WHERE jsonb_typeof(m.semantic_profile) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_each(m.semantic_profile) AS f(k, v)
    WHERE jsonb_typeof(f.v) = 'object'
      AND f.v ->> 'source' IN ('candidate', 'llm', 'memory', 'derived', 'tool', 'booking', 'extraction', 'enrichment')
  );

UPDATE public.agent_long_term_memories AS m
SET
  semantic_job_intent = (
    SELECT jsonb_object_agg(
             f.k,
             CASE WHEN jsonb_typeof(f.v) = 'object' AND jsonb_typeof(f.v -> 'source') = 'string'
                  THEN f.v || jsonb_build_object('source', pg_temp.canonical_fact_producer(f.v ->> 'source'))
                  ELSE f.v END
           )
    FROM jsonb_each(m.semantic_job_intent) AS f(k, v)
  ),
  updated_at = now()
WHERE jsonb_typeof(m.semantic_job_intent) = 'object'
  AND EXISTS (
    SELECT 1 FROM jsonb_each(m.semantic_job_intent) AS f(k, v)
    WHERE jsonb_typeof(f.v) = 'object'
      AND f.v ->> 'source' IN ('candidate', 'llm', 'memory', 'derived', 'tool', 'booking', 'extraction', 'enrichment')
  );

-- 4. 读边界 CAS 懒迁移 RPC 随兼容层一并下线
DROP FUNCTION IF EXISTS public.migrate_long_term_episodic_state_atomic(text, text, text, jsonb, jsonb, jsonb, jsonb);

