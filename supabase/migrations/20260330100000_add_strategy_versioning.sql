-- ============================================================
-- 策略配置版本管理：testing / released / archived
-- ============================================================

-- 1. 删除旧的 is_active 唯一索引（必须先删，否则后续 INSERT 会冲突）
DROP INDEX IF EXISTS idx_strategy_config_active;

-- 2. 新增字段
ALTER TABLE strategy_config
ADD COLUMN IF NOT EXISTS status text DEFAULT 'released' NOT NULL,
ADD COLUMN IF NOT EXISTS version integer DEFAULT 1 NOT NULL,
ADD COLUMN IF NOT EXISTS version_note text,
ADD COLUMN IF NOT EXISTS released_at timestamptz;

-- 3. 迁移现有数据：当前 is_active=true 的记录标记为 released
UPDATE strategy_config
SET status = 'released',
    version = 1,
    released_at = updated_at
WHERE is_active = true;

-- 4. 基于 released 记录，创建一条 testing 记录（内容相同）
INSERT INTO strategy_config (
  name, description, persona, stage_goals, red_lines,
  industry_skills, role_setting, is_active, status, version
)
SELECT
  name, description, persona, stage_goals, red_lines,
  industry_skills, role_setting, true, 'testing', 0
FROM strategy_config
WHERE status = 'released'
LIMIT 1;

-- 5. 新约束：released 和 testing 各最多一条
CREATE UNIQUE INDEX idx_strategy_config_released
  ON strategy_config (status) WHERE (status = 'released' AND is_active = true);

CREATE UNIQUE INDEX idx_strategy_config_testing
  ON strategy_config (status) WHERE (status = 'testing' AND is_active = true);

-- 6. status 值约束
ALTER TABLE strategy_config
ADD CONSTRAINT strategy_config_status_check
  CHECK (status IN ('testing', 'released', 'archived'));
