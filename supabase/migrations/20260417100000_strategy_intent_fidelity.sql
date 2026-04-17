-- ============================================================
-- Migration: 意向保真红线 + job_consultation 拉群/止推策略
--
-- 背景：线上 Agent 在岗位推荐时推动力过强，候选人意向超出当前可推范围时，
-- 倾向于用"替代区域/品牌/岗位"继续硬推，而不会诚实告知不匹配并转为拉群。
--
-- 本迁移做三件事（对所有 strategy_config 行生效，含 testing / released / archived）：
--
-- 1. red_lines.rules 追加"意向保真"红线——禁止扭曲候选人已明确表达的意向。
-- 2. job_consultation 阶段追加一条 ctaStrategy：已无匹配可能时止推 + 拉群。
-- 3. job_consultation 阶段追加一条 disallowedActions：禁止无岗后仍硬推替代。
-- 4. job_consultation.primaryGoal 的无条件 "推动形成明确面试意向" 改为有条件：
--    意向可覆盖才推面试，否则如实告知并转拉群。仅在 primaryGoal 匹配已知前缀
--    时改写，避免误伤运营自定义文案。
--
-- 设计要点：
-- - 幂等：每条追加前判定是否已存在；primaryGoal 改写仅匹配已知旧文本。
-- - 与 20260415160000 / 20260415170000 两次迁移的风格保持一致。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  new_red_line text := '严禁为了推荐成功而扭曲或重新诠释候选人已明确表达的意向（品牌、岗位类型、城市、区域、班次、薪资等）；当候选人意向超出当前可推范围时，直接如实告知不匹配，不得用替代品牌、区域或岗位假装满足原意向。';
  new_cta_item text := '当你判断本会话在候选人当前意向下已无匹配可能（意向超出可推范围，或继续检索已无新进展）时，停止继续推荐，诚实告知无合适岗位，并在已知城市的前提下调用 invite_to_group 拉群让候选人获取后续机会。';
  new_disallowed_item text := '已判断候选人当前意向下无可推荐岗位后，仍以替代岗位、区域或品牌继续硬推，或把不符意向的岗位包装成意向匹配。';
  old_primary_goal text := '根据工具数据提供清晰、真实的岗位信息，并用打包式推荐帮助候选人缩小到可考虑的岗位或门店，突出真正影响决策的差异，推动形成明确面试意向。';
  new_primary_goal text := '根据工具数据提供清晰、真实的岗位信息，并用打包式推荐帮助候选人缩小到可考虑的岗位或门店，突出真正影响决策的差异；在候选人意向可被当前岗位池覆盖时推动形成明确面试意向，否则如实告知不匹配并调用 invite_to_group 转拉群。';
  existing_rules jsonb;
  updated_rules jsonb;
  updated_stages jsonb;
  stage_elem jsonb;
  i int;
  cta_arr jsonb;
  disallowed_arr jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines, stage_goals FROM strategy_config LOOP
    -- ===== 1. 追加 red_lines.rules（意向保真红线） =====
    existing_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    updated_rules := existing_rules;

    IF NOT (updated_rules @> jsonb_build_array(new_red_line)) THEN
      updated_rules := updated_rules || to_jsonb(new_red_line);
    END IF;

    IF updated_rules IS DISTINCT FROM existing_rules THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;

    -- ===== 2/3/4. job_consultation 阶段追加 CTA / disallowed / 改写 primaryGoal =====
    updated_stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(updated_stages) - 1 LOOP
      stage_elem := updated_stages -> i;

      IF stage_elem ->> 'stage' = 'job_consultation' THEN
        -- 2. 追加 ctaStrategy
        cta_arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        IF NOT (cta_arr @> jsonb_build_array(new_cta_item)) THEN
          cta_arr := cta_arr || to_jsonb(new_cta_item);
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', cta_arr);
        END IF;

        -- 3. 追加 disallowedActions
        disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        IF NOT (disallowed_arr @> jsonb_build_array(new_disallowed_item)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(new_disallowed_item);
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);
        END IF;

        -- 4. 改写 primaryGoal：仅当当前值等于已知旧文本时才替换，避免误伤自定义
        IF stage_elem ->> 'primaryGoal' = old_primary_goal THEN
          stage_elem := jsonb_set(stage_elem, '{primaryGoal}', to_jsonb(new_primary_goal));
        END IF;

        updated_stages := jsonb_set(updated_stages, ARRAY[i::text], stage_elem);
      END IF;
    END LOOP;

    IF updated_stages IS DISTINCT FROM COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb) THEN
      UPDATE strategy_config
      SET stage_goals = jsonb_set(
        COALESCE(stage_goals, '{}'::jsonb),
        '{stages}',
        updated_stages
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
