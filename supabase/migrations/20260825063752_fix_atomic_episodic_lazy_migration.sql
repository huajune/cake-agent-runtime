-- M5 深审裁定四补丁：读边界懒迁移必须与 append/mark 并发安全。
--
-- 应用侧先把刚读到的旧形状规范化，再把“旧值 + 新值”一起交给本 RPC。
-- UPDATE 的旧值比较是 compare-and-swap：若 append_long_term_summary_atomic 或
-- mark_long_term_settled_boundary 已先推进摘要/水位，本次不写，并返回数据库当前值。
-- 这样读路径不会用较早快照覆盖并发写入。
CREATE FUNCTION migrate_long_term_episodic_state_atomic(
  p_corp_id text,
  p_user_id text,
  p_bot_user_id text,
  p_expected_session_summaries jsonb,
  p_expected_consolidation_watermarks jsonb,
  p_session_summaries jsonb,
  p_consolidation_watermarks jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  current_session_summaries jsonb;
  current_consolidation_watermarks jsonb;
BEGIN
  IF NULLIF(BTRIM(p_bot_user_id), '') IS NULL THEN
    RAISE EXCEPTION 'p_bot_user_id must be a stable wecomUserId';
  END IF;
  IF jsonb_typeof(p_session_summaries) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'p_session_summaries must be a json array';
  END IF;
  IF jsonb_typeof(p_consolidation_watermarks) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'p_consolidation_watermarks must be a json object';
  END IF;

  UPDATE public.agent_long_term_memories
  SET
    episodic_session_summaries = p_session_summaries,
    consolidation_watermarks = p_consolidation_watermarks,
    updated_at = now()
  WHERE corp_id = p_corp_id
    AND user_id = p_user_id
    AND bot_user_id = p_bot_user_id
    AND COALESCE(episodic_session_summaries, default_long_term_summary_data())
        = COALESCE(p_expected_session_summaries, default_long_term_summary_data())
    AND COALESCE(consolidation_watermarks, default_consolidation_watermarks())
        = COALESCE(p_expected_consolidation_watermarks, default_consolidation_watermarks())
  RETURNING episodic_session_summaries, consolidation_watermarks
  INTO current_session_summaries, current_consolidation_watermarks;

  IF NOT FOUND THEN
    SELECT episodic_session_summaries, consolidation_watermarks
    INTO current_session_summaries, current_consolidation_watermarks
    FROM public.agent_long_term_memories
    WHERE corp_id = p_corp_id
      AND user_id = p_user_id
      AND bot_user_id = p_bot_user_id;
  END IF;

  IF current_session_summaries IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN jsonb_build_object(
    'episodic_session_summaries', current_session_summaries,
    'consolidation_watermarks', current_consolidation_watermarks
  );
END;
$$;

COMMENT ON FUNCTION migrate_long_term_episodic_state_atomic(
  text,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb
) IS 'CAS 懒迁移 episodic 旧形状；并发写已推进时只返回当前值，不覆盖摘要或 consolidation 水位';
