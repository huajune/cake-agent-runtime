-- ============================================================
-- 策略发布 RPC：原子化 testing → released → archived
-- ============================================================

CREATE OR REPLACE FUNCTION publish_strategy(p_version_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  v_testing  strategy_config%ROWTYPE;
  v_released strategy_config%ROWTYPE;
  v_max_ver  integer;
  v_new_testing_id uuid;
BEGIN
  -- 1. 获取 testing 记录
  SELECT * INTO v_testing
  FROM strategy_config
  WHERE status = 'testing' AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No testing config found';
  END IF;

  -- 2. 获取 released 记录
  SELECT * INTO v_released
  FROM strategy_config
  WHERE status = 'released' AND is_active = true
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No released config found';
  END IF;

  -- 3. 获取最大版本号
  SELECT COALESCE(MAX(version), 0) INTO v_max_ver FROM strategy_config;

  -- 4. released → archived
  UPDATE strategy_config
  SET status = 'archived', is_active = false
  WHERE id = v_released.id;

  -- 5. testing → released
  UPDATE strategy_config
  SET status = 'released',
      version = v_max_ver + 1,
      version_note = p_version_note,
      released_at = now()
  WHERE id = v_testing.id;

  -- 6. 创建新 testing（从刚发布的内容复制）
  INSERT INTO strategy_config (
    name, description, persona, stage_goals, red_lines,
    industry_skills, role_setting, is_active, status, version
  ) VALUES (
    v_testing.name, v_testing.description, v_testing.persona,
    v_testing.stage_goals, v_testing.red_lines, v_testing.industry_skills,
    v_testing.role_setting, true, 'testing', 0
  )
  RETURNING id INTO v_new_testing_id;

  -- 返回新 released 记录
  RETURN jsonb_build_object(
    'released_id', v_testing.id,
    'archived_id', v_released.id,
    'new_testing_id', v_new_testing_id,
    'version', v_max_ver + 1
  );
END;
$$;
