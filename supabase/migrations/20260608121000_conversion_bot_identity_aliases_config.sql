-- ------------------------------------------------------------
-- 转化看板 bot 身份别名动态配置
--
-- 用途：
--   账号重新登录/换设备/绑定后，底层 bot_im_id 可能变化；看板读取侧可通过该配置
--   将「新 bot_im_id」临时归并到「旧/稳定 bot_im_id」，避免同一招募经理裂成多行。
--
-- 配置形态：
-- {
--   "newBotImId": {
--     "canonicalBotImId": "oldOrStableBotImId",
--     "managerName": "展示名，可选"
--   }
-- }
--
-- 注意：
--   本迁移只初始化空配置，不写入任何真实账号映射；生产映射由运维在 Supabase
--   system_config 中维护。根治方案仍是写入侧落库稳定 wecomUserId 后按稳定身份聚合。
-- ------------------------------------------------------------

INSERT INTO system_config (key, value, description)
VALUES (
  'conversion_bot_identity_aliases',
  '{}'::jsonb,
  '转化看板 bot 身份别名配置：newBotImId -> { canonicalBotImId, managerName? }'
)
ON CONFLICT (key) DO NOTHING;
