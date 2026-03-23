-- 策略配置变更日志表
-- 每次运营修改 persona / stage_goals / red_lines 时写入一条记录
-- 用于审计追溯和回滚

CREATE TABLE IF NOT EXISTS strategy_config_changelog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  config_id uuid NOT NULL REFERENCES strategy_config(id) ON DELETE CASCADE,
  field text NOT NULL,               -- 变更字段：persona / stage_goals / red_lines
  old_value jsonb,                   -- 变更前的完整值
  new_value jsonb NOT NULL,          -- 变更后的完整值
  changed_at timestamptz NOT NULL DEFAULT now(),

  -- 预留：未来可记录操作人
  changed_by text
);

-- 按 config_id + 时间倒序查询
CREATE INDEX idx_changelog_config_time ON strategy_config_changelog (config_id, changed_at DESC);

-- 按字段筛选
CREATE INDEX idx_changelog_field ON strategy_config_changelog (field);

-- RLS
ALTER TABLE strategy_config_changelog ENABLE ROW LEVEL SECURITY;

CREATE POLICY "service_role_full_access" ON strategy_config_changelog
  FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "anon_read_only" ON strategy_config_changelog
  FOR SELECT TO anon USING (true);
