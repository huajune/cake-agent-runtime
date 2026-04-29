-- ============================================================
-- Migration: 接管触发关键词 + 包餐强偏好处理
--
-- 背景：final-check 精简过程中识别出两条尚未沉淀到策略的硬规则，
-- 这里统一下沉到 strategy_config，使 final-check 可以删除对应条款：
--
--   R-17 接管触发关键词 — 候选人提到"刚面试过 / 通过了吗 / 已经办入职 /
--        店长让我来的 / 我们餐厅找的我 / 想改约时间 / 取消预约"等关键词时，
--        必须立即 request_handoff，不再自行推进。
--        放到 red_lines.rules，因为属于跨阶段强制触发。
--
--   job_consultation 包餐强偏好 — 候选人表达"没饭吃不去了 / 拉倒了"等
--        包餐强偏好时，停止继续收资料/推进面试，改为开 includeWelfare=true
--        重新查岗，或诚实告知暂无匹配。
--        放到 job_consultation.ctaStrategy。
--
-- 设计：与 20260429140000_strategy_p1_red_lines.sql 一致，用 @> 幂等校验，
-- 覆盖所有 strategy_config 行（含 archived），避免运营回滚后再现旧策略。
-- ============================================================

-- =====================================================================
-- Part A: R-17 接管触发关键词 → red_lines.rules
-- =====================================================================
DO $$
DECLARE
  rec RECORD;
  handoff_rule text :=
    '候选人本轮提到"刚面试过 / 通过了吗 / 已经办入职 / 店长让我来的 / 我们餐厅找的我 / 想改约时间 / 取消预约"等关键词时，立即调用 request_handoff，不要继续自行推进对话或回避问题。';
  updated_rules jsonb;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    updated_rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);

    IF NOT (updated_rules @> jsonb_build_array(handoff_rule)) THEN
      updated_rules := updated_rules || to_jsonb(handoff_rule);

      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        updated_rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;

-- =====================================================================
-- Part B: 包餐强偏好 → job_consultation.ctaStrategy
-- =====================================================================
DO $$
DECLARE
  rec RECORD;
  stages jsonb;
  stage_elem jsonb;
  stage_name text;
  i int;
  meal_cta text :=
    '候选人表达包餐 / 不包饭强偏好（如"没饭吃不去了 / 拉倒了"）时，停止继续收面试资料或催推岗位，改为开 includeWelfare=true 重新查岗筛选包餐岗位；查到无匹配时直接告知，不得用不包餐岗位敷衍。';
  arr jsonb;
BEGIN
  FOR rec IN SELECT id, stage_goals FROM strategy_config LOOP
    stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);
    IF jsonb_typeof(stages) <> 'array' THEN CONTINUE; END IF;

    FOR i IN 0 .. jsonb_array_length(stages) - 1 LOOP
      stage_elem := stages -> i;
      stage_name := stage_elem ->> 'stage';

      IF stage_name = 'job_consultation' THEN
        arr := COALESCE(stage_elem -> 'ctaStrategy', '[]'::jsonb);
        IF NOT (arr @> jsonb_build_array(meal_cta)) THEN
          arr := arr || to_jsonb(meal_cta);
          stage_elem := jsonb_set(stage_elem, '{ctaStrategy}', arr);
          stages := jsonb_set(stages, ARRAY[i::text], stage_elem);
        END IF;
      END IF;
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
