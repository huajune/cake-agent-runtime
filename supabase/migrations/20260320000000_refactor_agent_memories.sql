-- ============================================================
-- 重构 agent_memories 表：每用户一行，Profile 平铺 + Summary jsonb
--
-- 变更说明：
-- 1. Profile 身份字段平铺为独立列（可索引、可查询）
-- 2. summary_data jsonb（分层压缩：recent[] + archive）
-- 3. message_metadata jsonb（消息回调元数据）
-- 4. 唯一约束改为 (corp_id, user_id) — 每用户一行
-- 5. 删除旧的 memory_key, category, content, type, expires_at 列
-- ============================================================

-- 1. 添加新列
ALTER TABLE agent_memories
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS gender text,
  ADD COLUMN IF NOT EXISTS age text,
  ADD COLUMN IF NOT EXISTS is_student boolean,
  ADD COLUMN IF NOT EXISTS education text,
  ADD COLUMN IF NOT EXISTS has_health_certificate text,
  ADD COLUMN IF NOT EXISTS summary_data jsonb,
  ADD COLUMN IF NOT EXISTS message_metadata jsonb;

-- 2. 迁移已有数据（从 content jsonb 提取到平铺列）
UPDATE agent_memories
SET
  name = content->>'name',
  phone = content->>'phone',
  gender = content->>'gender',
  age = content->>'age',
  is_student = (content->>'is_student')::boolean,
  education = content->>'education',
  has_health_certificate = content->>'has_health_certificate'
WHERE content IS NOT NULL;

-- 3. 删除旧约束和索引
ALTER TABLE agent_memories
  DROP CONSTRAINT IF EXISTS agent_memories_corp_id_user_id_memory_key_key;

DROP INDEX IF EXISTS idx_agent_memories_category;

-- 4. 删除旧列
ALTER TABLE agent_memories
  DROP COLUMN IF EXISTS memory_key,
  DROP COLUMN IF EXISTS category,
  DROP COLUMN IF EXISTS content,
  DROP COLUMN IF EXISTS expires_at;

-- 5. 创建新的唯一约束（每用户一行）
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_memories_user_unique
  ON agent_memories (corp_id, user_id);
