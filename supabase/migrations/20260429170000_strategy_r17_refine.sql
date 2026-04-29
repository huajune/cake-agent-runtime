-- ============================================================
-- Migration: R-17 措辞强化（覆盖"候选人追问其他地区/品牌"场景）
--
-- 背景：2026-04-29 P1 v3 定向验证（batch=fcfc629e）跑完后，t8hr0qkv 与
-- e3rvo7sv 仍 FAIL。Agent 在历史里看到上一轮自己说过"换个品牌看看？"，
-- 本轮候选人追问"别的地区有吗"时顺承展开"其他品牌可以吗"——LLM 把这种
-- "回应候选人追问"解读为不属于"主动反问"，绕过 R-17 原措辞。
--
-- 强化方向：明确把"候选人主动追问其他地区/品牌"也纳入 R-17 适用范围；
-- 并显式禁止"借候选人追问继续推荐其他品牌/跨城"的扩张推荐路径。
-- ============================================================

DO $$
DECLARE
  rec RECORD;

  old_r17 text :=
    '无岗收口红线：duliday_job_list 在候选人明确范围内返回 0 条，且已合理放宽过一次（同城邻区 / 同品牌邻店 / 放宽距离）仍 0 时，必须直接告知"暂时没有合适岗位"并按场景调用 invite_to_group 收口；严禁继续反问候选人"换个地区 / 换个品牌 / 换个城市看看"。候选人主动表达扩张意愿前不再继续扩查。';

  new_r17 text :=
    '无岗收口红线：duliday_job_list 在候选人明确范围内返回 0 条，且已合理放宽过一次（同城邻区 / 同品牌邻店 / 放宽距离）仍 0 时，必须直接告知"暂时没有合适岗位"并按场景调用 invite_to_group 收口；严禁继续反问候选人"换个地区 / 换个品牌 / 换个城市看看"。**候选人主动追问"别的地区有吗 / 别的品牌呢 / 还有其他吗"时本红线同样适用——必须基于本轮工具结果直接告知"该品牌/城市暂时无岗"，不得借候选人的追问展开"其他品牌可以吗 / 看看长沙吗 / 上海杭州看看"等扩张推荐**；即使历史轨迹里 Agent 自己上一轮提议过换品牌/换地区，本轮也必须打破这条轨迹直接收口，不得顺承延续。候选人明确表达扩张意愿前不再继续扩查。';

  rules jsonb;
  filtered_rules jsonb;
  rule_elem jsonb;
  changed boolean;
BEGIN
  FOR rec IN SELECT id, red_lines FROM strategy_config LOOP
    rules := COALESCE(rec.red_lines -> 'rules', '[]'::jsonb);
    changed := false;

    -- Step 1: 移除旧 R-17（如果存在）
    IF rules @> jsonb_build_array(old_r17) THEN
      filtered_rules := '[]'::jsonb;
      FOR rule_elem IN SELECT * FROM jsonb_array_elements(rules) LOOP
        IF rule_elem #>> '{}' <> old_r17 THEN
          filtered_rules := filtered_rules || rule_elem;
        END IF;
      END LOOP;
      rules := filtered_rules;
      changed := true;
    END IF;

    -- Step 2: 追加新 R-17（如果不存在）
    IF NOT (rules @> jsonb_build_array(new_r17)) THEN
      rules := rules || to_jsonb(new_r17);
      changed := true;
    END IF;

    IF changed THEN
      UPDATE strategy_config
      SET red_lines = jsonb_set(
        COALESCE(red_lines, '{}'::jsonb),
        '{rules}',
        rules
      )
      WHERE id = rec.id;
    END IF;
  END LOOP;
END $$;
