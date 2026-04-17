-- ============================================================
-- Migration: 策略配置全面精简与冗余归口
--
-- 背景：整体审查 candidate-consultation prompt + strategy_config 后发现
-- 多处冗余、术语不一致、硬规则错位。本迁移在 DB 侧一次性处理以下问题：
--
-- A. max_reply_chars 40 字与"打包式推荐"根本冲突，放宽到 120 字
-- B. 身份保护（机器人/托管/系统/AI）归口到 red_lines；每个 stage 的
--    disallowedActions 末尾都重复一条，全部删除
-- C. 上一迁移把"意向保真"写入 job_consultation 的 ctaStrategy 和
--    disallowedActions 造成自我冗余；归口到 red_lines + primaryGoal，
--    删除 ctaStrategy / disallowedActions 里的两条重复
-- D. trust_building.disallowedActions 三条寒暄类合并为一条
-- E. job_consultation.disallowedActions 三条"信息呈现失控"类合并为一条
-- F. interview_scheduling.ctaStrategy 中"返回 success 才算约面成功"
--    属于硬规则而非 CTA，且 disallowedActions 已有等价条款，删除
-- G. 术语统一：岗位信息包 / 打包式信息推荐 / 机会包 → 打包式推荐；
--    平替 → 替代方向
-- H. job_consultation.ctaStrategy 无匹配动作链统一为一句话，与
--    primaryGoal 协调
--
-- 设计要点：
-- - 幂等：所有修改先判等再写；id 级别 UPDATE
-- - 覆盖所有 strategy_config 行（含 archived），避免运营回滚到历史版本时
--   又出现被清理掉的冗余
-- ============================================================

-- =====================================================================
-- Part A: 放宽 max_reply_chars 40 → 120
-- =====================================================================
DO $$
DECLARE
  rec RECORD;
  new_thresholds jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    new_thresholds := COALESCE(rec.red_lines -> 'thresholds', '[]'::jsonb);

    SELECT jsonb_agg(
      CASE
        WHEN t ->> 'flag' = 'max_reply_chars'
        THEN jsonb_set(t, '{max}', '120'::jsonb)
        ELSE t
      END
    )
    INTO new_thresholds
    FROM jsonb_array_elements(new_thresholds) AS t;

    IF new_thresholds IS DISTINCT FROM (rec.red_lines -> 'thresholds') THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{thresholds}',
        COALESCE(new_thresholds, '[]'::jsonb)
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- =====================================================================
-- Part B-H: 阶段级精简 / 合并 / 术语统一
-- =====================================================================
DO $$
DECLARE
  rec RECORD;
  stages jsonb;
  stage_elem jsonb;
  stage_name text;
  i int;
  identity_protect_rule text := '在回复中暴露「机器人」「托管」「系统」「自动回复」「AI」等非真人身份字眼。';
  -- C. 上一迁移加入 job_consultation 的两条冗余
  intent_fidelity_cta text := '当你判断本会话在候选人当前意向下已无匹配可能（意向超出可推范围，或继续检索已无新进展）时，停止继续推荐，诚实告知无合适岗位，并在已知城市的前提下调用 invite_to_group 拉群让候选人获取后续机会。';
  intent_fidelity_disallowed text := '已判断候选人当前意向下无可推荐岗位后，仍以替代岗位、区域或品牌继续硬推，或把不符意向的岗位包装成意向匹配。';
  -- D. trust_building 合并
  trust_old_1 text := '把 trust_building 当成完整信息收集或寒暄阶段，候选人已在问具体岗位信息时仍围绕破冰或位置确认兜圈';
  trust_old_2 text := '做长篇、客服式、自报家门的开场介绍，或机械复读候选人昵称，使用"嗨XX""你好XX"这类称呼';
  trust_old_3 text := '默认开场追问"你是在找工作吗""想找兼职吗"';
  trust_merged text := '客服式/自报家门式的冗长开场、机械复读昵称（"嗨XX""你好XX"）、反问候选人是否在找工作、或候选人已在问具体岗位时仍围绕破冰兜圈。';
  -- E. job_consultation 合并
  jobc_old_1 text := '绝对禁止挤牙膏式推岗：查到合适门店时，只报店名或只答单一字段，不主动补充候选人评估所需的关键信息';
  jobc_old_2 text := '未缩小到区域或商圈前，就先抛跨区门店列表，制造信息噪音';
  jobc_old_3 text := '直接把后台接口返回的原始复杂规则复制粘贴甩给对方';
  jobc_merged text := '信息呈现失控：查到合适门店只报店名或单答一个字段式挤牙膏推岗；未收敛到区域或商圈前就抛跨区门店列表制造信息噪音；直接把接口返回的原始复杂规则复制粘贴甩给候选人。';
  -- F. interview_scheduling CTA 错位硬规则
  interview_misplaced_cta text := '调用 duliday_interview_booking 返回 success 才算约面成功';
  -- H. 无匹配动作链统一
  old_no_match_cta text := '基于候选人的核心痛点主动提炼符合项；若当前区域或品牌暂无匹配，不编造，只在查到明确平替后再推荐替代区域或品牌，否则直接说清当前没有';
  new_no_match_cta text := '基于候选人的核心痛点主动提炼符合项；当前区域或品牌暂无匹配时，查到明确替代方向可推荐替代，没有明确替代时直接告知候选人当前没有合适岗位并调用 invite_to_group 拉群；一律不编造不美化。';
  -- 辅助函数变量
  arr jsonb;
  new_arr jsonb;
  elem jsonb;
  elem_text text;
BEGIN
  FOR rec IN SELECT id, stage_goals FROM strategy_config LOOP
    stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);
    IF jsonb_typeof(stages) <> 'array' THEN CONTINUE; END IF;

    FOR i IN 0 .. jsonb_array_length(stages) - 1 LOOP
      stage_elem := stages -> i;
      stage_name := stage_elem ->> 'stage';

      -- =========== B. 删除 disallowedActions 末尾身份保护条款 ===========
      arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO new_arr
        FROM jsonb_array_elements(arr) AS value
       WHERE value <> to_jsonb(identity_protect_rule);
      IF new_arr IS DISTINCT FROM arr THEN
        stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
      END IF;

      -- =========== D. trust_building: 合并三条寒暄类 ===========
      IF stage_name = 'trust_building' THEN
        arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(trust_old_1)
           AND value <> to_jsonb(trust_old_2)
           AND value <> to_jsonb(trust_old_3);
        IF new_arr IS DISTINCT FROM arr THEN
          IF NOT (new_arr @> jsonb_build_array(trust_merged)) THEN
            -- 把合并后的一条放到数组开头，保留其它顺序
            new_arr := jsonb_build_array(trust_merged) || new_arr;
          END IF;
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
        END IF;
      END IF;

      -- =========== C + E + G + H. job_consultation 多项处理 ===========
      IF stage_name = 'job_consultation' THEN
        -- C. 删除 ctaStrategy 中的意向保真冗余条
        arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(intent_fidelity_cta);
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', new_arr);
        END IF;

        -- C. 删除 disallowedActions 中的意向保真冗余条
        arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(intent_fidelity_disallowed);
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
        END IF;

        -- E. 合并三条信息呈现类
        arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(jobc_old_1)
           AND value <> to_jsonb(jobc_old_2)
           AND value <> to_jsonb(jobc_old_3);
        IF new_arr IS DISTINCT FROM arr THEN
          IF NOT (new_arr @> jsonb_build_array(jobc_merged)) THEN
            new_arr := jsonb_build_array(jobc_merged) || new_arr;
          END IF;
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
        END IF;

        -- H. 无匹配动作链统一：替换 ctaStrategy 中的旧句为新句
        arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        new_arr := '[]'::jsonb;
        FOR elem IN SELECT * FROM jsonb_array_elements(arr) LOOP
          IF elem = to_jsonb(old_no_match_cta) THEN
            new_arr := new_arr || to_jsonb(new_no_match_cta);
          ELSE
            new_arr := new_arr || elem;
          END IF;
        END LOOP;
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', new_arr);
        END IF;

        -- G. 术语统一：对 primaryGoal / description / ctaStrategy / disallowedActions 做文本替换
        -- primaryGoal
        IF stage_elem ? 'primaryGoal' THEN
          stage_elem := jsonb_set(
            stage_elem, '{primaryGoal}',
            to_jsonb(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(stage_elem ->> 'primaryGoal', '打包式信息推荐', '打包式推荐', 'g'),
                    '岗位信息包', '打包式推荐', 'g'),
                  '机会包', '打包式推荐', 'g'),
                '明确平替', '明确替代方向', 'g'
              )
            )
          );
        END IF;
        -- description
        IF stage_elem ? 'description' THEN
          stage_elem := jsonb_set(
            stage_elem, '{description}',
            to_jsonb(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(stage_elem ->> 'description', '打包式信息推荐', '打包式推荐', 'g'),
                    '岗位信息包', '打包式推荐', 'g'),
                  '机会包', '打包式推荐', 'g'),
                '明确平替', '明确替代方向', 'g'
              )
            )
          );
        END IF;
        -- ctaStrategy: 逐条替换
        arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        new_arr := '[]'::jsonb;
        FOR elem IN SELECT * FROM jsonb_array_elements(arr) LOOP
          elem_text := elem #>> '{}';
          IF elem_text IS NOT NULL THEN
            elem_text := regexp_replace(elem_text, '打包式信息推荐', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '岗位信息包', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '机会包', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '明确平替', '明确替代方向', 'g');
            new_arr := new_arr || to_jsonb(elem_text);
          ELSE
            new_arr := new_arr || elem;
          END IF;
        END LOOP;
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', new_arr);
        END IF;
        -- disallowedActions: 逐条替换
        arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        new_arr := '[]'::jsonb;
        FOR elem IN SELECT * FROM jsonb_array_elements(arr) LOOP
          elem_text := elem #>> '{}';
          IF elem_text IS NOT NULL THEN
            elem_text := regexp_replace(elem_text, '打包式信息推荐', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '岗位信息包', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '机会包', '打包式推荐', 'g');
            elem_text := regexp_replace(elem_text, '明确平替', '明确替代方向', 'g');
            new_arr := new_arr || to_jsonb(elem_text);
          ELSE
            new_arr := new_arr || elem;
          END IF;
        END LOOP;
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
        END IF;
      END IF;

      -- =========== F. interview_scheduling: 删除错位硬规则 ===========
      IF stage_name = 'interview_scheduling' THEN
        arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(interview_misplaced_cta);
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', new_arr);
        END IF;
      END IF;

      stages := jsonb_set(stages, ARRAY[i::text], stage_elem);
    END LOOP;

    IF stages IS DISTINCT FROM COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb) THEN
      UPDATE strategy_config
      SET stage_goals = jsonb_set(
        COALESCE(stage_goals, '{}'::jsonb),
        '{stages}',
        stages
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
