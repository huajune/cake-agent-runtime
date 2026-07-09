-- 补齐辛瑜琦/瑜琦组托管成员配置。
--
-- 背景：
--   2026-07-08 PR #477 在代码常量与 seed 脚本中新增了 botImId
--   1688855468965879，但 system_config.hosting_member_config 属运行时配置，
--   不会被常规 Supabase migration 自动更新，导致生产配置可能漏同步。
--
-- 安全：
--   这里只补飞书接收人 open_id/name，不写 Duliday token。
--   若生产后续给该 member 手工维护了 dulidayToken，本迁移重复执行也会保留。

INSERT INTO system_config (key, value, description)
VALUES (
  'hosting_member_config',
  '{
    "members": {
      "1688855468965879": {
        "feishuOpenId": "ou_c88101c10aa900578ec97b6c6d529fa1",
        "feishuName": "辛瑜琦"
      }
    }
  }'::jsonb,
  '托管成员统一配置（飞书+海绵token）'
)
ON CONFLICT (key) DO UPDATE
SET
  value = jsonb_set(
    CASE
      WHEN COALESCE(system_config.value, '{}'::jsonb) ? 'members'
        THEN COALESCE(system_config.value, '{}'::jsonb)
      ELSE COALESCE(system_config.value, '{}'::jsonb) || '{"members": {}}'::jsonb
    END,
    '{members,1688855468965879}',
    COALESCE(
      system_config.value #> '{members,1688855468965879}',
      '{}'::jsonb
    ) || '{
      "feishuOpenId": "ou_c88101c10aa900578ec97b6c6d529fa1",
      "feishuName": "辛瑜琦"
    }'::jsonb,
    true
  ),
  description = COALESCE(system_config.description, EXCLUDED.description),
  updated_at = now();
