-- Drop legacy long-term memory table.
--
-- Runtime has used agent_long_term_memories since 20260527120000_create_agent_long_term_memories.
-- The old agent_memories table and its old RPCs are no longer part of the application path.

DROP FUNCTION IF EXISTS append_summary_atomic(text, text, jsonb, text, int);
DROP FUNCTION IF EXISTS upsert_profile_with_confidence_guard(text, text, jsonb, jsonb, jsonb);

-- 先删表（连带删除表上 trigger），再删 trigger 函数；
-- 不能 DROP TRIGGER ... ON agent_memories：表已不存在时 IF EXISTS 只管 trigger、不管表，会直接报错。
DROP TABLE IF EXISTS agent_memories;
DROP FUNCTION IF EXISTS update_agent_memories_updated_at();
