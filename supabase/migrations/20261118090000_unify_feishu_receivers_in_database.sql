-- 一次性迁移历史代码接收人；运行时名单统一维护 system_config.hosting_member_config。
-- 仅补缺失的接收人，保留 DB 自定义接收人、河南账号、token、人设和其他配置。
-- 必须先执行本迁移，再部署移除代码兜底的版本；可安全重复执行。
DO $$
DECLARE
  config_value jsonb;
  members_value jsonb;
  target_entry jsonb;
  seed_entry record;
BEGIN
  INSERT INTO system_config (key, value, description)
  VALUES ('hosting_member_config', '{"members": {}}'::jsonb, '托管成员及飞书接收人统一配置')
  ON CONFLICT (key) DO NOTHING;

  SELECT value INTO config_value FROM system_config
  WHERE key = 'hosting_member_config' FOR UPDATE;
  IF jsonb_typeof(config_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hosting_member_config 必须是 object';
  END IF;
  members_value := COALESCE(config_value->'members', '{}'::jsonb);
  IF jsonb_typeof(members_value) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'hosting_member_config.members 必须是 object';
  END IF;

  FOR seed_entry IN SELECT * FROM jsonb_each($seed${
  "1688855974513959": {
    "feishuOpenId": "ou_54b8b053840d689ae42d3ab6b61800d8",
    "feishuName": "高雅琪"
  },
  "1688854747775509": {
    "feishuOpenId": "ou_72e8d17db5dab36e4feeddfccaa6568d",
    "feishuName": "艾酱"
  },
  "1688855171908166": {
    "feishuOpenId": "ou_e6868065cb0baa3c0304441a6a8c16e7",
    "feishuName": "李宇航"
  },
  "1688854363869800": {
    "feishuOpenId": "ou_9834f6ccffb3abdbeeabbc28581af6df",
    "feishuName": "祝东升"
  },
  "1688857592548257": {
    "feishuOpenId": "ou_9834f6ccffb3abdbeeabbc28581af6df",
    "feishuName": "祝东升"
  },
  "1688856098846503": {
    "feishuOpenId": "ou_9834f6ccffb3abdbeeabbc28581af6df",
    "feishuName": "祝东升"
  },
  "1688854359801821": {
    "feishuOpenId": "ou_954fb7341fd7fdd320de2d419d26df19",
    "feishuName": "南瓜"
  },
  "1688854263771949": {
    "feishuOpenId": "ou_12cf003c378f89299f8ccf32252c22c0",
    "feishuName": "盼盼"
  },
  "1688855753660960": {
    "feishuOpenId": "ou_6d3f217a88b5033ff256c64492e52ae7",
    "feishuName": "小阳"
  },
  "1688855468965879": {
    "feishuOpenId": "ou_c88101c10aa900578ec97b6c6d529fa1",
    "feishuName": "辛瑜琦"
  },
  "1688857954985709": {
    "feishuOpenId": "ou_a519e2e0172ced44c9fca02daa2d7ffa",
    "feishuName": "蒋一锋"
  }
}$seed$::jsonb)
  LOOP
    target_entry := COALESCE(members_value->seed_entry.key, '{}'::jsonb);
    IF jsonb_typeof(target_entry) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION '托管成员配置必须是 object';
    END IF;
    IF COALESCE(btrim(target_entry->>'feishuOpenId'), '') = '' THEN
      target_entry := target_entry || seed_entry.value;
    END IF;
    members_value := jsonb_set(members_value, ARRAY[seed_entry.key], target_entry, true);
  END LOOP;
  config_value := jsonb_set(config_value, '{members}', members_value, true);

  -- 群满、拉群失败、群任务汇总沿用原固定运营接收人。显式空数组也属于有效覆盖。
  IF NOT config_value ? 'operationsReceivers' THEN
    config_value := jsonb_set(config_value, '{operationsReceivers}', '[{"openId": "ou_54b8b053840d689ae42d3ab6b61800d8", "name": "高雅琪"}]'::jsonb, true);
  ELSIF jsonb_typeof(config_value->'operationsReceivers') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'operationsReceivers 必须是 array';
  END IF;

  UPDATE system_config SET value = config_value, updated_at = now()
  WHERE key = 'hosting_member_config' AND value IS DISTINCT FROM config_value;
END
$$;
