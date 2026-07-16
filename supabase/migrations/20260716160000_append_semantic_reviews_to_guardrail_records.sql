-- Semantic Reviewer 的完整判例统一归档到 guardrail_review_records。
--
-- shadow 评审是异步 fire-and-forget，可能先于或晚于 runner 的 hard-rule/repair 档案写入；
-- 因此用 RPC 原子追加 semantic_reviews，禁止普通 upsert 覆盖同 trace 的另一条写入路径。

ALTER TABLE guardrail_review_records
  ADD COLUMN IF NOT EXISTS semantic_reviews JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN guardrail_review_records.semantic_reviews IS
  'Semantic Reviewer 完整判例序列：mode/decision/confidence/findings/draftReply/reviewedAt；包含 shadow 与 enforce 首审/二审';

CREATE OR REPLACE FUNCTION append_guardrail_semantic_review(
  p_trace_id text,
  p_chat_id text,
  p_user_id text,
  p_bot_user_name text,
  p_contact_name text,
  p_user_message text,
  p_draft_reply text,
  p_review jsonb
)
RETURNS TABLE(appended boolean)
LANGUAGE plpgsql
AS $$
DECLARE
  review_with_time jsonb;
BEGIN
  IF p_trace_id IS NULL OR btrim(p_trace_id) = '' OR p_draft_reply IS NULL OR btrim(p_draft_reply) = '' THEN
    RETURN QUERY SELECT false;
    RETURN;
  END IF;

  review_with_time := p_review || jsonb_build_object('reviewedAt', now());

  INSERT INTO guardrail_review_records AS target (
    trace_id,
    chat_id,
    user_id,
    bot_user_name,
    contact_name,
    user_message,
    first_reply,
    first_decision,
    first_rule_ids,
    first_blocked_rule_ids,
    first_violations,
    repaired,
    final_decision,
    semantic_reviews
  ) VALUES (
    p_trace_id,
    p_chat_id,
    p_user_id,
    p_bot_user_name,
    p_contact_name,
    p_user_message,
    p_draft_reply,
    'pass',
    '{}',
    '{}',
    '[]'::jsonb,
    false,
    'pass',
    jsonb_build_array(review_with_time)
  )
  ON CONFLICT (trace_id) DO UPDATE SET
    chat_id = COALESCE(target.chat_id, EXCLUDED.chat_id),
    user_id = COALESCE(target.user_id, EXCLUDED.user_id),
    bot_user_name = COALESCE(target.bot_user_name, EXCLUDED.bot_user_name),
    contact_name = COALESCE(target.contact_name, EXCLUDED.contact_name),
    user_message = COALESCE(target.user_message, EXCLUDED.user_message),
    semantic_reviews = COALESCE(target.semantic_reviews, '[]'::jsonb) || EXCLUDED.semantic_reviews;

  RETURN QUERY SELECT true;
END;
$$;

COMMENT ON FUNCTION append_guardrail_semantic_review(text, text, text, text, text, text, text, jsonb) IS
  '原子追加 Semantic Reviewer 判例；与 runner 守卫档案并发时只合并 semantic_reviews，不覆盖首审/修复字段';
