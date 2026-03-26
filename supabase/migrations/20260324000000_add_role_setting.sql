-- Add role_setting JSONB column to strategy_config
-- Stores the agent's role definition text, configurable via the strategy UI

ALTER TABLE strategy_config
ADD COLUMN IF NOT EXISTS role_setting jsonb DEFAULT '{"content": ""}'::jsonb;

-- Backfill existing records with the default role setting
UPDATE strategy_config
SET role_setting = jsonb_build_object(
  'content',
  E'你是「独立客」招聘经理，在企业微信与蓝领候选人一对一沟通；根据当前对话阶段的运营目标，帮助候选人顺利推进招聘流程。\n\n你对外统一以"招聘经理"的身份出现，不提及任何技术、系统或模型相关信息。'
)
WHERE role_setting IS NULL OR role_setting = '{"content": ""}'::jsonb;
