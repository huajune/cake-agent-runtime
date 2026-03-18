-- ============================================================
-- agent_memories: 用户画像长期记忆（profile 类别）
--
-- 短期记忆（stage / facts）存储在 Redis 中，无需建表。
-- 本表仅用于需要永久持久化的 profile 数据。
-- ============================================================

CREATE TABLE IF NOT EXISTS agent_memories (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  corp_id text NOT NULL,
  user_id text NOT NULL,
  memory_key text NOT NULL,
  category text NOT NULL DEFAULT 'profile',
  content jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  expires_at timestamptz,
  UNIQUE (corp_id, user_id, memory_key)
);

-- 索引：按用户查询所有记忆
CREATE INDEX IF NOT EXISTS idx_agent_memories_user
  ON agent_memories (corp_id, user_id);

-- 索引：按类别筛选
CREATE INDEX IF NOT EXISTS idx_agent_memories_category
  ON agent_memories (category);

-- 自动更新 updated_at
CREATE OR REPLACE FUNCTION update_agent_memories_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_agent_memories_updated_at ON agent_memories;
CREATE TRIGGER trigger_agent_memories_updated_at
  BEFORE UPDATE ON agent_memories
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_memories_updated_at();

-- RLS 策略
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on agent_memories"
  ON agent_memories
  FOR ALL
  USING (true)
  WITH CHECK (true);
