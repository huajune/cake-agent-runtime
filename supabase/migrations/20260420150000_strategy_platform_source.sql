-- ============================================================
-- Migration: 平台来源识别
--
-- 背景：badcase `758jtzta` —— 候选人开场说“您好boss直聘”本意是说明自己来自 boss
-- 渠道，Agent 却把它理解为对自身身份的质疑，回复“我不是 boss 直聘”，让候选人困惑。
--
-- 本迁移在 trust_building 阶段追加一条 disallowedActions，明确禁止对渠道/平台名做
-- 身份否认或反问。prompt 层同步补充了“平台来源识别规则”段，二者配合生效。
--
-- 设计要点：
-- - 幂等：追加前判定是否已存在。
-- - 与 20260417110000 合并风格一致，只改 trust_building；其它阶段不受影响。
-- ============================================================

DO $$
DECLARE
  rec RECORD;
  new_disallowed_item text := '对候选人提到的渠道来源（boss / BOSS / 直聘 / 58 / 58同城 / 猎聘 / 赶集等平台名）进行身份否认、澄清或反问（如"我不是 boss"、"这不是 boss 官方"），应把这些词理解为"候选人来自该渠道"的上下文补充，直接推进到了解需求。';
  updated_stages jsonb;
  stage_elem jsonb;
  i int;
  disallowed_arr jsonb;
BEGIN
  FOR rec IN SELECT id, stage_goals FROM strategy_config LOOP
    updated_stages := COALESCE(rec.stage_goals -> 'stages', '[]'::jsonb);

    FOR i IN 0 .. jsonb_array_length(updated_stages) - 1 LOOP
      stage_elem := updated_stages -> i;

      IF stage_elem ->> 'stage' = 'trust_building' THEN
        disallowed_arr := COALESCE(stage_elem -> 'disallowedActions', '[]'::jsonb);
        IF NOT (disallowed_arr @> jsonb_build_array(new_disallowed_item)) THEN
          disallowed_arr := disallowed_arr || to_jsonb(new_disallowed_item);
          stage_elem := jsonb_set(stage_elem, '{disallowedActions}', disallowed_arr);
          updated_stages := jsonb_set(updated_stages, ARRAY[i::text], stage_elem);
        END IF;
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
