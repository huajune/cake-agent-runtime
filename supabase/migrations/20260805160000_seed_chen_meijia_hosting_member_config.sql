-- 补齐陈美嘉（LiYuHang）/小祝组托管成员配置。
--
-- botImId: 1688856098846503
-- 飞书告警归属：祝东升
--
-- 安全约定：migration 不包含也不复制 Duliday token。目标账号已有 token 时原样保留；
-- 各环境的 token 由受控运行时配置流程单独维护，避免全新建库时依赖外部 secret。

DO $$
DECLARE
  config_value jsonb;
  members_value jsonb;
  target_entry jsonb;
BEGIN
  INSERT INTO system_config (key, value, description)
  VALUES (
    'hosting_member_config',
    '{"members": {}}'::jsonb,
    '托管成员统一配置（飞书+海绵token）'
  )
  ON CONFLICT (key) DO NOTHING;

  SELECT value
  INTO config_value
  FROM system_config
  WHERE key = 'hosting_member_config'
  FOR UPDATE;

  IF jsonb_typeof(config_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hosting_member_config.value 必须是 JSON object';
  END IF;

  members_value := COALESCE(config_value->'members', '{}'::jsonb);
  IF jsonb_typeof(members_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hosting_member_config.members 必须是 JSON object';
  END IF;

  target_entry := COALESCE(members_value->'1688856098846503', '{}'::jsonb);
  IF jsonb_typeof(target_entry) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hosting_member_config.members.1688856098846503 必须是 JSON object';
  END IF;

  target_entry := target_entry || jsonb_build_object(
    'feishuOpenId', 'ou_9834f6ccffb3abdbeeabbc28581af6df',
    'feishuName', '祝东升',
    'wecomNickname', '陈美嘉',
    'gender', '女'
  );

  config_value := jsonb_set(config_value, '{members}', members_value, true);
  config_value := jsonb_set(
    config_value,
    '{members,1688856098846503}',
    target_entry,
    true
  );

  UPDATE system_config
  SET
    value = config_value,
    description = COALESCE(description, '托管成员统一配置（飞书+海绵token）'),
    updated_at = now()
  WHERE key = 'hosting_member_config'
    AND (
      value IS DISTINCT FROM config_value
      OR description IS NULL
    );
END
$$;
