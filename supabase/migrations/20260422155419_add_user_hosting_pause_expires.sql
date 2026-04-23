-- 用户托管暂停增加自动解禁期限（默认 3 天）
-- 设计：暂停时由应用层计算 pause_expires_at = paused_at + 3 days 写入；
-- 查询/判定时过滤 pause_expires_at > now()；过期记录由应用层 lazy 回写为已恢复。

ALTER TABLE user_hosting_status
  ADD COLUMN IF NOT EXISTS pause_expires_at timestamp with time zone;

COMMENT ON COLUMN user_hosting_status.pause_expires_at IS '暂停自动解禁时间（NULL 视为不过期；早于 now() 视为已过期，由应用层回写恢复）';

-- 加速「未过期暂停用户」查询
CREATE INDEX IF NOT EXISTS idx_user_hosting_status_paused_expires
  ON user_hosting_status (is_paused, pause_expires_at)
  WHERE is_paused = true;

-- 回填存量：从迁移时刻起再给 3 天，避免一升级就把现存暂停用户全部解禁
UPDATE user_hosting_status
SET pause_expires_at = now() + interval '3 days'
WHERE is_paused = true
  AND pause_expires_at IS NULL;
