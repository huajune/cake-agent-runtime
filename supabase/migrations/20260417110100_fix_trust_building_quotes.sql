-- ============================================================
-- Migration: 修复 20260417110000 中文弯引号导致的漏删
--
-- 原 trust_building.disallowedActions 两条使用中文弯引号（“”），
-- 上一迁移中字符串字面量用了英文直引号（""），导致未命中未删除。
-- 本迁移用正确的中文引号补删。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  stages jsonb;
  stage_elem jsonb;
  i int;
  arr jsonb;
  new_arr jsonb;
  -- 注意：这里特意使用中文弯引号 U+201C / U+201D
  trust_old_2 text := '做长篇、客服式、自报家门的开场介绍，或机械复读候选人昵称，使用“嗨XX”“你好XX”这类称呼';
  trust_old_3 text := '默认开场追问“你是在找工作吗”“想找兼职吗”';
BEGIN
  FOR rec IN SELECT id, stage_goals FROM strategy_config LOOP
    stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);
    IF jsonb_typeof(stages) <> 'array' THEN CONTINUE; END IF;

    FOR i IN 0 .. jsonb_array_length(stages) - 1 LOOP
      stage_elem := stages -> i;
      IF stage_elem ->> 'stage' = 'trust_building' THEN
        arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
          INTO new_arr
          FROM jsonb_array_elements(arr) AS value
         WHERE value <> to_jsonb(trust_old_2)
           AND value <> to_jsonb(trust_old_3);
        IF new_arr IS DISTINCT FROM arr THEN
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', new_arr);
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
